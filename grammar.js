// Kippy grammar (Sketch C). Design rationale: notes/syntax.md
//
// decl = [pub] name [generics] [: type] [= value]
// The RHS decides the kind: record/choice/shape/distinct/alias/tag/intrinsic
// make it a type, anything else makes it a value.
//
// Separators: comma in values/types, semicolon in blocks.
// Arrows: => body follows, -> return, ->! effectful return.

const PREC = {
  MATCH: 1,
  PIPE: 2,
  OR: 3,
  AND: 4,
  COMPARE: 5,
  ADD: 6,
  MUL: 7,
  UNARY: 8,
  POSTFIX: 9,
};

const KEYWORDS = [
  "pub",
  "rec",
  "mut",
  "alias",
  "distinct",
  "tag",
  "record",
  "choice",
  "shape",
  "intrinsic",
  "expect",
  "if",
  "then",
  "else",
  "case",
  "where",
  "module",
  "use",
  "derive",
  "fn",
  "test",
  "or",
  "and",
  "not",
  "mod",
  "as",
  "in",
  "self",
  "Self",
];

// digit runs may contain underscores but not start or end with one
const DEC_DIGITS = "(?:[0-9]|[0-9][0-9_]*[0-9])";
const HEX_DIGITS = "(?:[0-9a-fA-F]|[0-9a-fA-F][0-9a-fA-F_]*[0-9a-fA-F])";
const OCT_DIGITS = "(?:[0-7]|[0-7][0-7_]*[0-7])";
const BIN_DIGITS = "(?:[01]|[01][01_]*[01])";
const INT_SUFFIX = "(?:U8|U16|U32|U64|I8|I16|I32|I64)?";
const FLOAT_SUFFIX = "(?:F32|F64)?";
const PERCENT = "%";
const EXPONENT = "(?:[eE][+-]?(?:[0-9]|[0-9][0-9_]*[0-9]))";
const DEC_POINT = // 1.5, 1., .5
  `(?:${DEC_DIGITS}\\.${DEC_DIGITS}|${DEC_DIGITS}\\.|\\.${DEC_DIGITS})`;
const ESCAPE_BODY =
  `(?:[ntrbfv0'"\\\\]|x[0-9A-Fa-f]{2}|u\\([0-9A-Fa-f]{1,8}\\)|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})`;

// --- helpers -----------------------------------------------------------------
const opt = optional;
const many = repeat;

function sep1(rule, separator) {
  return seq(rule, many(seq(separator, rule)));
}

// trailing separator allowed
function separated1(rule, separator) {
  return seq(rule, many(seq(separator, rule)), opt(separator));
}

function collection(open, close, item, separator) {
  return seq(open, opt(separated1(item, separator)), close);
}

function fieldPattern(fieldName, colon, valueRule) {
  return choice(seq(fieldName, colon, valueRule), fieldName);
}

// single = non-associative (comparisons: a < b < c shouldn't parse)
function leftAssocBinop(
  precedence,
  operandRule,
  opRule,
  { single = false } = {},
) {
  if (single) {
    return prec.left(
      precedence,
      seq(
        field("lhs", operandRule),
        opt(seq(field("op", opRule), field("rhs", operandRule))),
      ),
    );
  }
  return prec.left(
    precedence,
    seq(
      field("lhs", operandRule),
      many(seq(field("op", opRule), field("rhs", operandRule))),
    ),
  );
}

// --- kippy-specific helpers --------------------------------------------------
function bracedCollection($, rule, separator) {
  return collection($.lbrace, $.rbrace, rule, separator);
}
function bracedSemiBlock($, rule) {
  return bracedCollection($, rule, $.semicolon);
}

function parenPayloadList($, payloadRule) {
  return seq(
    $.lparen,
    separated1(field("payload", payloadRule), $.comma),
    $.rparen,
  );
}

// 2+ items. `(a)` is parenthesized, `(a,)` is invalid, there is no 1-tuple.
function tuple($, item) {
  return seq(
    $.lparen,
    field("element", item),
    $.comma,
    field("element", item),
    many(seq($.comma, field("element", item))),
    opt($.comma),
    $.rparen,
  );
}

function bracketedWithRest(open, close, item, separator, rest) {
  return seq(
    open,
    opt(choice(seq(sep1(item, separator), opt(seq(separator, rest))), rest)),
    close,
  );
}

function withAttributes($, ...rest) {
  return seq(many(field("attribute", $.attribute)), ...rest);
}

function optTypeParams($) {
  return opt(field("type_params", $.type_parameter_list));
}

module.exports = grammar({
  name: "kippy",
  word: ($) => $.identifier,
  reserved: { global: ($) => KEYWORDS.map((k) => $[`kw_${k}`]) },

  extras: ($) => [
    new RustRegex("[ \\t\\r\\f]+"),
    new RustRegex("\\r?\\n"),
    $.line_comment,
    $.block_comment,
  ],

  supertypes: ($) => [$.expression, $.type_constructor],

  inline: ($) => [
    $.value_slot,
    $.match_arm_value,
    $.lambda_body,
    $.if_then_value,
    $.if_else_value,
    $._declaration_inner,
    $._top_level_item,
  ],

  rules: {
    // --- source structure ---
    source_file: ($) => seq(opt($.module_declaration), repeat($.module_item)),

    module_declaration: ($) => seq($.kw_module, field("name", $.path)),

    module_item: ($) => withAttributes($, $._top_level_item),
    _top_level_item: ($) => choice($.use_statement, $.declaration),

    // `use foo { a, b }` — no dot before the brace
    use_statement: ($) =>
      seq(
        $.kw_use,
        field("module", $.path),
        opt(seq($.kw_as, field("alias", $.identifier))),
        opt(field("imports", $.import_set)),
      ),
    import_set: ($) =>
      seq($.lbrace, opt(separated1($.import_item, $.comma)), $.rbrace),
    import_item: ($) =>
      seq(
        field("name", $.identifier),
        opt(seq($.kw_as, field("alias", $.identifier))),
      ),

    // --- declarations ---
    declaration: ($) =>
      seq(field("visibility", opt($.kw_pub)), $._declaration_inner),

    _declaration_inner: ($) =>
      choice(
        $.binding,
        $.derive_declaration,
        $.test_declaration,
      ),

    // Values, types and shape implementations are all this one rule.
    // `constraints` appears twice; the resolver rejects using both.
    binding: ($) =>
      seq(
        opt($.kw_rec),
        field("name", $.binding_name),
        optTypeParams($),
        choice(
          seq(
            $.colon,
            field("annotation", $.binding_annotation),
            opt(field("constraints", $.constraint_clause)),
            opt(seq($.equals, $.value_slot)),
          ),
          seq($.equals, $.value_slot),
        ),
        opt(field("constraints", $.constraint_clause)),
      ),

    binding_annotation: ($) =>
      choice(
        field("constructor", $.type_constructor),
        field("type", $.type_expression),
      ),

    type_constructor: ($) =>
      choice(
        $.alias_constructor,
        $.distinct_constructor,
        $.tag_constructor,
        $.intrinsic_constructor,
        $.record_constructor,
        $.choice_constructor,
        $.shape_constructor,
      ),

    // --- type constructors (RHS of a binding's colon) ---
    alias_constructor: ($) => seq($.kw_alias, field("body", $.type_expression)),

    // always wraps: UserId : distinct Int. Payload-less marker? use tag.
    distinct_constructor: ($) =>
      seq($.kw_distinct, field("body", $.type_expression)),

    tag_constructor: ($) => $.kw_tag,

    // compiler supplies the representation; pairs with a #lang(...) attr
    intrinsic_constructor: ($) => $.kw_intrinsic,

    record_constructor: ($) => seq($.kw_record, field("body", $.record_type)),

    choice_constructor: ($) =>
      seq($.kw_choice, field("body", bracedSemiBlock($, $.choice_variant))),

    // No `type` members — put the varying type in the parameter list.
    shape_constructor: ($) =>
      seq(
        $.kw_shape,
        opt(field("parents", $.shape_parents)),
        field("members", bracedSemiBlock($, $.shape_method)),
      ),

    choice_variant: ($) =>
      withAttributes(
        $,
        field("name", $.identifier),
        opt(choice(
          parenPayloadList($, $.type_expression),
          field("payload", $.record_type),
        )),
      ),

    type_parameter_list: ($) =>
      collection($.lbracket, $.rbracket, $.identifier, $.comma),

    // --- shapes ---
    shape_parents: ($) =>
      seq($.colon, sep1(field("parent", $.path_or_applied), $.comma)),
    shape_method: ($) =>
      withAttributes(
        $,
        field("name", $.binding_name),
        $.colon,
        field("type_ann", $.type_expression),
        opt(field("default", $.method_default)),
        opt(field("constraints", $.constraint_clause)),
      ),
    method_default: ($) => seq($.equals, $.value_slot),

    // derive UserId : Eq + Ord + Hash
    derive_declaration: ($) =>
      seq(
        $.kw_derive,
        optTypeParams($),
        field("type", $._concrete_type_head),
        $.colon,
        field("shape", $.constraint_sum),
        opt(field("constraints", $.constraint_clause)),
      ),

    // --- attributes ---
    attribute: ($) =>
      seq(
        $.hash_sign,
        field("path", $.path),
        opt(field("args", $.attribute_arguments_inline)),
      ),
    attribute_arguments_inline: ($) =>
      collection($.lparen, $.rparen, $.attribute_argument, $.comma),
    attribute_argument: ($) =>
      choice(
        $.attribute_value,
        seq(
          field("name", $.identifier),
          $.equals,
          field("value", $.attribute_value),
        ),
      ),
    attribute_value: ($) =>
      choice(
        $.percent_literal,
        $.int_literal,
        $.float_literal,
        $.char_literal,
        $.static_text,
        $.path,
        $.attribute_list_value,
        $.attribute_record_value,
        seq($.lparen, $.attribute_value, $.rparen),
      ),
    attribute_list_value: ($) =>
      collection($.lbracket, $.rbracket, $.attribute_value, $.comma),
    attribute_record_value: ($) =>
      bracedCollection($, $.attribute_record_field, $.comma),
    attribute_record_field: ($) =>
      seq(
        field("name", $.field_name),
        $.equals,
        field("value", $.attribute_value),
      ),

    // --- tests ---
    test_declaration: ($) =>
      seq(
        $.kw_test,
        field("name", $.static_text),
        field("body", bracedSemiBlock($, $.test_statement)),
      ),
    test_statement: ($) => choice($.test_binding, $.expect_statement),
    test_binding: ($) => $.binding,
    expect_statement: ($) => seq($.kw_expect, field("value", $.expression)),

    // --- names ---
    // both are identifiers; split so tooling can tell a field from a binding
    binding_name: ($) => $.identifier,
    field_name: ($) => $.identifier,

    // --- expressions ---
    expression: ($) =>
      choice(
        $.lambda_expression,
        $.if_expression,
        $.pipe_expression,
      ),

    value_slot: ($) => field("value", $.expression),
    if_then_value: ($) => field("then_value", $.expression),
    if_else_value: ($) => field("else_value", $.expression),
    lambda_body: ($) => field("body", $.expression),
    match_arm_value: ($) => field("value", $.expression),

    spread_element: ($) => seq($.rest_op, field("base", $.expression)),

    // --- operator ladder (loosest to tightest) ---
    pipe_expression: ($) => leftAssocBinop(PREC.PIPE, $.or_expression, $.pipe),
    or_expression: ($) => leftAssocBinop(PREC.OR, $.and_expression, $.or_op),
    and_expression: ($) =>
      leftAssocBinop(PREC.AND, $.compare_expression, $.and_op),
    compare_expression: ($) =>
      leftAssocBinop(
        PREC.COMPARE,
        $.add_expression,
        choice($.le_op, $.ge_op, $.eq_op, $.ne_op, $.lt_op, $.gt_op),
        { single: true },
      ),
    add_expression: ($) =>
      leftAssocBinop(PREC.ADD, $.mul_expression, choice($.plus_op, $.minus_op)),
    mul_expression: ($) =>
      leftAssocBinop(
        PREC.MUL,
        $.unary_expression,
        choice($.star_op, $.slash_op, $.kw_mod),
      ),

    unary_expression: ($) =>
      choice(
        prec.right(
          PREC.UNARY,
          seq(
            field("op", choice($.minus_op, $.kw_not)),
            field("operand", $.unary_expression),
          ),
        ),
        $.match_expression,
      ),

    match_expression: ($) =>
      prec(
        PREC.MATCH,
        choice(
          seq(
            field("subject", $.postfix_expression),
            $.kw_case,
            field("body", bracedSemiBlock($, $.match_arm)),
          ),
          $.postfix_expression,
        ),
      ),

    // --- postfix chain ---
    postfix_expression: ($) =>
      prec.left(
        PREC.POSTFIX,
        seq(
          field("base", $.primary_expression),
          many(choice(
            $.record_suffix,
            $.call_suffix,
            $.index_suffix,
            $.field_suffix,
            $.tuple_index_suffix,
            $.try_op,
            $.method_suffix,
          )),
        ),
      ),

    call_suffix: ($) =>
      seq(
        $.lparen,
        opt(separated1(field("arg", $.call_argument), $.comma)),
        $.rparen,
      ),
    call_argument: ($) => $.expression,
    index_suffix: ($) =>
      seq($.lbracket, field("index", $.expression), $.rbracket),
    field_suffix: ($) => seq($.dot, field("field", $.field_name)),

    // `l.0`. field_name is an identifier, so digits need their own rule.
    // `1.0` still lexes as a float (longest match at the start of a primary);
    // `t.0.1` is four tokens, since float_literal isn't valid after `dot`.
    tuple_index_suffix: ($) => seq($.dot, field("index", $.tuple_index)),
    tuple_index: () => token.immediate(new RustRegex("[0-9]+")),

    // @ finds the implementation by type. `:Shape` is only for a method name
    // declared by two different shapes.
    method_suffix: ($) =>
      seq(
        $.at_sign,
        field("method", $.path),
      ),
    record_suffix: ($) => field("body", $.record_body),

    // --- primary ---
    // unit/tuple/parenthesized share `(`: `()` is unit, then `,` selects tuple
    // and `)` selects parenthesized. Same split in patterns and types.
    primary_expression: ($) =>
      choice(
        $.block_expression,
        $.literal,
        $.path,
        $.placeholder,
        $.unit_expression,
        $.list_expression,
        $.map_expression,
        $.tuple_expression,
        $.parenthesized_expression,
      ),

    unit_expression: ($) => seq($.lparen, $.rparen),

    list_expression: ($) =>
      collection($.lbracket, $.rbracket, $.list_item, $.comma),
    list_item: ($) => choice($.expression, $.spread_element),
    map_expression: ($) =>
      collection($.lbracket_map, $.rbracket, $.map_entry, $.comma),
    map_entry: ($) =>
      seq(field("key", $.expression), $.fat_arrow, $.value_slot),

    tuple_expression: ($) => tuple($, $.expression),
    parenthesized_expression: ($) =>
      seq($.lparen, field("value", $.expression), $.rparen),

    // also the implementation body: Task : Display = { show = ... }
    record_body: ($) => bracedCollection($, $.record_field, $.comma),
    record_field: ($) =>
      choice(
        seq(field("name", $.field_name), $.equals, $.value_slot),
        $.spread_element,
      ),

    // --- control flow ---
    // Replaces let..in. `^` marks the value that exits the block, and is not
    // optional: without it `{ a` is ambiguous between a binding and a result,
    // costing six declared conflicts. Measured, not guessed.
    //
    // Was: many(seq($.local_binding, $.semicolon)). A block statement is now
    // one of three forms (binding, assignment, loop) instead of only bindings.
    block_expression: ($) =>
      seq(
        $.lbrace,
        many(seq($.local_statement, $.semicolon)),
        $.caret,
        field("result", $.expression),
        $.rbrace,
      ),

    // value namespace only — no type constructors locally
    //
    // `mut` sits where `rec` does; the choice makes `rec mut` a parse error
    // for free. `mut` means "this name may take successive values", never
    // "shared mutable storage" — see the resolver rules in notes/syntax.md.
    local_binding: ($) =>
      seq(
        opt(choice($.kw_rec, $.kw_mut)),
        field("pattern", $.binding_pattern),
        opt(seq($.colon, field("type_ann", $.type_expression))),
        $.equals,
        $.value_slot,
      ),

    // A block statement starts with a pattern. The token right after it
    // decides which form it is: `=` -> local_binding, `in` -> loop_statement.
    // One token of lookahead, so no restricted copy of the expression ladder
    // is needed anywhere, and the iterable below can be any expression.
    local_statement: ($) =>
      choice($.local_binding, $.assignment, $.loop_statement),

    // x in values => { ... };
    // (k, v) in pairs |> filter(p) => { ... };
    // {name, ..} in users => { ... };
    //
    // The `=>` is load-bearing for error recovery, not decoration: without
    // it, the body's `{` is a legal continuation of a broken iterable (a
    // block expression or a record suffix), so a truncated iterable eats the
    // body and cascades into the rest of the enclosing block. With `=>` as a
    // hard resync point, damage stays local to the loop statement. Measured,
    // not guessed — same discipline as `^` above.
    loop_statement: ($) =>
      seq(
        field("pattern", $.binding_pattern),
        $.kw_in,
        field("iterable", $.expression),
        $.fat_arrow,
        field("body", $.loop_body),
      ),

    // No `^`: the body produces no value. Loop-carried state is `mut` in the
    // enclosing block; the loop lowers to a collapse (fold) over `iterable`
    // with those `mut` locals as the accumulator.
    loop_body: ($) =>
      choice(
        seq($.lbrace, many(seq($.local_statement, $.semicolon)), $.rbrace),
        $.unbraced_statement,
      ),

    // u.score = e, xs[0] = e, u.tags[0].name = e.
    // Bare `x = e` (no suffix) is always a local_binding, never this rule —
    // the resolver decides bind-vs-rebind by scope, so there is no overlap
    // and no declared conflict.
    assignment: ($) =>
      seq(field("target", $.lvalue), $.equals, $.value_slot),
    lvalue: ($) =>
      seq(
        field("base", $.identifier),
        repeat1(choice($.field_suffix, $.index_suffix, $.tuple_index_suffix)),
      ),

    if_expression: ($) =>
      prec.right(seq(
        $.kw_if,
        field("condition", $.pipe_expression),
        $.kw_then,
        $.if_then_value,
        $.kw_else,
        $.if_else_value,
      )),

    // `else =>` is not `_ =>`: the totality checker treats else as deliberate
    // incompleteness and names the variants it swallows.
    match_arm: ($) =>
      choice(
        seq(field("pattern", $.pattern), $.fat_arrow, $.match_arm_value),
        seq($.kw_else, $.fat_arrow, $.match_arm_value),
      ),

    // fn (a: Int, b: Int) -> Int => a + b; both annotations optional.
    // `fn(` also opens function_type — disjoint positions, but if tree-sitter
    // reports a conflict, look here first.
    lambda_parameter: ($) =>
      seq(
        field("pattern", $.binding_pattern),
        opt(seq($.colon, field("type_ann", $.type_expression))),
      ),
    lambda_parameters: ($) =>
      collection($.lparen, $.rparen, field("param", $.lambda_parameter), $.comma),
    lambda_expression: ($) =>
      prec.right(seq(
        $.kw_fn,
        $.lambda_parameters,
        opt(seq(
          field("arrow", choice($.arrow, $.effect_arrow)),
          field("return_type", $.type_expression),
        )),
        $.fat_arrow,
        $.lambda_body,
      )),

    // --- patterns ---
    pattern: ($) =>
      seq($.unguarded_pattern, opt(seq($.kw_if, field("guard", $.expression)))),
    unguarded_pattern: ($) => $.or_pattern,

    or_pattern: ($) => prec.left(sep1($.as_pattern, $.bar)),
    as_pattern: ($) =>
      prec.right(
        1,
        choice(
          seq($.atomic_pattern, $.kw_as, field("binding", $.identifier)),
          $.atomic_pattern,
        ),
      ),

    atomic_pattern: ($) =>
      choice(
        $.literal,
        $.unit_pattern,
        $.wildcard_pattern,
        $.path_pattern,
        $.list_pattern,
        $.tuple_pattern,
        $.record_pattern,
        $.parenthesized_pattern,
      ),

    path_pattern: ($) =>
      seq(
        field("constructor", $.path),
        opt(bracketedWithRest(
          $.lparen,
          $.rparen,
          field("payload", $.tag_payload_pattern),
          $.comma,
          $.rest_pattern,
        )),
      ),
    // alias of `pattern`; split it out if payload patterns ever diverge
    tag_payload_pattern: ($) => $.pattern,

    wildcard_pattern: ($) => $.wildcard,
    unit_pattern: ($) => seq($.lparen, $.rparen),

    list_pattern: ($) =>
      bracketedWithRest(
        $.lbracket,
        $.rbracket,
        $.pattern,
        $.comma,
        $.rest_pattern,
      ),
    tuple_pattern: ($) => tuple($, $.pattern),
    parenthesized_pattern: ($) =>
      seq($.lparen, field("value", $.pattern), $.rparen),
    record_pattern: ($) =>
      bracketedWithRest(
        $.lbrace,
        $.rbrace,
        $.record_pattern_field,
        $.comma,
        $.rest_op,
      ),
    record_pattern_field: ($) => fieldPattern($.field_name, $.colon, $.pattern),
    rest_pattern: ($) => seq($.rest_op, field("binding", $.identifier)),

    // irrefutable subset (params, local bindings): no literals, no constructors
    binding_pattern: ($) =>
      choice(
        $.unit_pattern,
        $.wildcard_pattern,
        $.identifier,
        $.binding_list_pattern,
        $.binding_tuple_pattern,
        $.binding_record_pattern,
        $.parenthesized_binding_pattern,
      ),
    binding_list_pattern: ($) =>
      bracketedWithRest(
        $.lbracket,
        $.rbracket,
        $.binding_pattern,
        $.comma,
        $.rest_pattern,
      ),
    binding_tuple_pattern: ($) => tuple($, $.binding_pattern),
    parenthesized_binding_pattern: ($) =>
      seq($.lparen, field("value", $.binding_pattern), $.rparen),
    binding_record_pattern: ($) =>
      bracketedWithRest(
        $.lbrace,
        $.rbrace,
        $.binding_record_pattern_field,
        $.comma,
        $.rest_op,
      ),
    binding_record_pattern_field: ($) =>
      fieldPattern($.field_name, $.colon, $.binding_pattern),

    // --- types ---
    type_expression: ($) =>
      choice($.base_type, seq($.ellipsis, field("item", $.base_type))),
    base_type: ($) =>
      choice($.function_type, $.wildcard_type, $._concrete_type_head),

    _concrete_type_head: ($) =>
      choice(
        $.path_or_applied,
        $.self_type,
        $.unit_type,
        $.tuple_type,
        $.record_type,
        $.parenthesized_type,
      ),

    path_or_applied: ($) =>
      seq(
        field("constructor", $.path),
        opt(field("args", $.type_argument_list)),
      ),
    type_argument_list: ($) =>
      collection($.lbracket, $.rbracket, $.type_expression, $.comma),

    // -> and ->! stay distinct tokens so the effect checker sees which was
    // written. Bare -> on a higher-order type is effect-polymorphic.
    function_type: ($) =>
      seq(
        $.kw_fn,
        collection($.lparen, $.rparen, field("param", $.type_expression), $.comma),
        opt(seq(
          field("arrow", choice($.arrow, $.effect_arrow)),
          field("result", $.type_expression),
        )),
      ),

    record_type: ($) => bracedCollection($, $.record_type_field, $.comma),
    record_type_field: ($) =>
      withAttributes(
        $,
        field("name", $.field_name),
        $.colon,
        field("type_ann", $.type_expression),
      ),
    tuple_type: ($) => tuple($, $.type_expression),
    self_type: ($) => $.kw_Self,
    unit_type: ($) => seq($.lparen, $.rparen),
    wildcard_type: ($) => $.wildcard,
    parenthesized_type: ($) =>
      seq($.lparen, field("value", $.type_expression), $.rparen),

    // --- constraints ---
    constraint_clause: ($) =>
      seq(
        $.kw_where,
        choice(
          $.constraint_entry,
          collection($.lparen, $.rparen, $.constraint_entry, $.comma),
        ),
      ),
    constraint_entry: ($) =>
      seq(
        field("type_var", $.identifier),
        $.colon,
        field("constraint", $.constraint_sum),
      ),
    // T : ShapeA + ShapeB. Also the RHS of derive.
    constraint_sum: ($) =>
      prec.left(seq(
        field("shape", $.path),
        many(seq($.plus_op, field("shape", $.path))),
      )),

    // --- literals ---
    literal: ($) =>
      choice(
        $.percent_literal,
        $.int_literal,
        $.float_literal,
        $.char_literal,
        $.text,
      ),

    // percent before float before int: 1.5% / 1.5 / 1 share a prefix, so the
    // order of these three rules matters. Order inside each does not.
    percent_literal: ($) =>
      token(
        new RustRegex(`(?:${DEC_POINT}|${DEC_DIGITS})${EXPONENT}?${PERCENT}`),
      ),
    float_literal: ($) =>
      token(
        new RustRegex(
          // no point? then an exponent is required: 1e9
          `(?:${DEC_POINT}${EXPONENT}?|${DEC_DIGITS}${EXPONENT})${FLOAT_SUFFIX}`,
        ),
      ),
    int_literal: ($) =>
      token(
        new RustRegex(
          `(?:0[bB]${BIN_DIGITS}|0[oO]${OCT_DIGITS}|0[xX]${HEX_DIGITS}|${DEC_DIGITS})${INT_SUFFIX}`,
        ),
      ),

    char_literal: ($) =>
      token(new RustRegex(`'(?:[^'\\\\]|\\\\${ESCAPE_BODY})'`)),

    // static_text is text minus interpolation, for compile-time constants.
    // The content token is shared and aliased: one lexer rule, two node names.
    text: ($) =>
      seq(
        $.quote,
        many(choice($.text_content, $.escape_sequence, $.interpolation)),
        $.quote,
      ),
    text_content: ($) => token(new RustRegex('[^"\\\\\\r\\n]+')),
    static_text: ($) =>
      seq(
        $.quote,
        many(choice(
          alias($.text_content, $.static_text_content),
          $.escape_sequence,
        )),
        $.quote,
      ),
    interpolation: ($) => seq($.interpolation_start, $.expression, $.rparen),
    interpolation_start: ($) => token(new RustRegex("\\\\\\(")), // \(
    escape_sequence: ($) => token(new RustRegex(`\\\\${ESCAPE_BODY}`)),

    // --- comments ---
    // NON-NESTING: `/* a /* b */ c */` ends at the first `*​/`. Nesting needs
    // an external scanner.
    line_comment: (_) => token(new RustRegex("//[^\\n]*")),
    block_comment: (_) =>
      token(seq("/*", /[^*]*\*+([^/*][^*]*\*+)*/, "/")),

    // --- identifiers, paths, operators ---
    identifier: ($) =>
      token(new RustRegex("[_\\p{ID_Start}][\\p{ID_Continue}]*")),
    path_head: ($) => choice($.identifier, $.kw_self),
    path: ($) => seq($.path_head, repeat(seq($.module_sep, $.identifier))),
    // one-argument lambda hole; its scope is the RHS of the enclosing binding
    // (resolver rule). `$.field` parses as placeholder + field_suffix.
    placeholder: ($) => token("$"),
    wildcard: ($) => "_",
    ellipsis: ($) => "...",
    rest_op: ($) => "..",

    // --- keyword tokens ---
    ...Object.fromEntries(KEYWORDS.map((k) => [`kw_${k}`, () => k])),

    // --- punctuation / operators ---
    lparen: () => "(",
    rparen: () => ")",
    lbracket: () => "[",
    rbracket: () => "]",
    lbrace: () => "{",
    rbrace: () => "}",
    lbracket_map: () => token("#["), // map open, vs list [
    quote: () => '"',
    comma: () => ",",
    colon: () => ":",
    equals: () => "=",
    semicolon: () => ";",
    dot: () => token.immediate("."), // immediate, so it's a suffix not a float
    module_sep: () => token.immediate("::"),
    at_sign: () => token.immediate("@"),
    hash_sign: () => "#",
    caret: () => "^", // block result marker

    pipe: () => token("|>"),
    bar: () => token("|"),
    or_op: ($) => $.kw_or,
    and_op: ($) => $.kw_and,
    plus_op: () => "+",
    minus_op: () => "-",
    star_op: () => "*",
    slash_op: () => "/",
    eq_op: () => "==",
    ne_op: () => "!=",
    le_op: () => "<=",
    ge_op: () => ">=",
    lt_op: () => "<",
    gt_op: () => ">",

    // one token, so ->! can't lex as -> then !=
    arrow: () => "->",
    effect_arrow: () => token("->!"),
    fat_arrow: () => "=>",
    try_op: () => "?",
  },
});
