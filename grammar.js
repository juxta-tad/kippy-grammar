// Kippy grammar (Sketch C). Design rationale: notes/syntax.md
//
// decl = [pub] name [generics] [: type] [= value]
// The RHS decides the kind: record/choice/shape/distinct/alias/tag/intrinsic
// make it a type, anything else makes it a value.
//
// Separators: comma in values/types, semicolon in blocks.
// Arrows: => body follows, -> return, ->! effectful return.

const PREC = {
  ASSIGN: 0,
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
  "for",
  "let",
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
        $.assignment_expression,
        $.pipe_expression,
      ),

    // x = 10;  x.field = e;  xs[0] = e;  a = b = c;
    // Lowest precedence, right-associative. `target` is an ordinary
    // postfix_expression — the SAME rule primary chains use everywhere
    // else, not a parallel lvalue rule — so there is exactly one
    // production for "identifier + suffix chain," never two competing
    // ones fighting over the same tokens. This is also what makes a bare
    // `x = 10` legal: a zero-suffix postfix_expression is just `x`.
    // Whether `target` resolves to something reassignable (a `mut` name)
    // and whether bare `x = 10` is a fresh binding or a rebind are both
    // resolver decisions, not grammar ones — same principle the old
    // local_binding used for bind-vs-rebind.
    //
    // Being part of `expression` means assignment can appear anywhere an
    // expression can — `foo(x = 10)`, `if x = 10 then a else b`, list
    // items, etc. — not just at statement position. RESOLVER RULE TO
    // ENFORCE: a bare name on the left introduces a new binding only when
    // the assignment_expression occurs directly as a local_statement;
    // anywhere else in expression position, the target must already exist
    // and be `mut`, or it's an error. This keeps `x = 10` inside a call
    // argument or condition from silently introducing `x` into an
    // enclosing scope.
    assignment_expression: ($) =>
      prec.right(PREC.ASSIGN, seq(
        field("target", $.postfix_expression),
        $.equals,
        $.value_slot,
      )),

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
    // No `^`. A block is Rust-shaped: statements end in `;`, and the
    // optional trailing expression with no `;` is the block's value. A
    // block with no trailing expression (ends in `;`, or is empty) has no
    // `result` field in the tree. RESOLVER RULE TO ENFORCE: treat an
    // absent `result` as the value `()`, not as a distinct "no value"
    // state — `{}` and `{ print(x); }` both evaluate to `()`, exactly as
    // if `()` had been written as the trailing expression. That keeps
    // `fn (x) ->! () => { print(x); }` well-typed with no special-casing.
    //
    // Disambiguating the tail from the last statement needs only one token
    // of lookahead (does `;` or `}` follow the expression just parsed?),
    // not the unbounded lookahead the old pattern-based local_binding had.
    // That's only true because assignment_expression folded into
    // `expression` itself (see above) — a plain identifier-plus-suffix-chain
    // now has exactly one production, so it can't fork between "assignment
    // statement" and "tail expression".
    block_expression: ($) =>
      seq(
        $.lbrace,
        many(seq($.local_statement, $.semicolon)),
        opt(field("result", $.expression)),
        $.rbrace,
      ),

    // x : Int = 10;  bonus : Int = score / 10;
    // `:` right after the name is a token no expression production can
    // consume there, so this never competes with assignment_expression.
    //
    // `mut` sits where `rec` does; the choice makes `rec mut` a parse error
    // for free. `mut` means "this name may take successive values", never
    // "shared mutable storage" — see the resolver rules in notes/syntax.md.
    typed_binding: ($) =>
      seq(
        opt(choice($.kw_rec, $.kw_mut)),
        field("name", $.identifier),
        $.colon,
        field("type_ann", $.type_expression),
        $.equals,
        $.value_slot,
      ),

    // let (a, b) = pair;  let {name, age} = user;  let [x, ..rest] = xs;
    // let x = 10;
    // Accepts any binding_pattern, including a bare identifier — `let x =
    // 10` is a legal, more explicit spelling of `x = 10`, not an error.
    // What `let` actually buys you is only needed for tuple/list/paren
    // patterns: a leading `let` commits the parser to "pattern incoming"
    // before any pattern content is read, so those never have to be told
    // apart from a block's tail expression — the ambiguity `^` used to
    // paper over for every pattern shape, not just assignment's.
    let_binding: ($) =>
      seq(
        $.kw_let,
        opt(choice($.kw_rec, $.kw_mut)),
        field("pattern", $.binding_pattern),
        opt(seq($.colon, field("type_ann", $.type_expression))),
        $.equals,
        $.value_slot,
      ),

    // A block statement's leading token decides the form outright: `let` ->
    // let_binding, `for` -> loop_statement, an identifier followed by `:` ->
    // typed_binding, and everything else -> expression (which covers plain
    // bindings and assignment via assignment_expression).
    local_statement: ($) =>
      choice($.typed_binding, $.let_binding, $.loop_statement, $.expression),

    // for x in scores(users) => total = total + x;
    // for x in scores(users) => { mut t = total; t = t + x; total = t; };
    // for (k, v) in pairs |> filter(p) => { ... };
    // for {name, ..} in team.members => names = [..names, name];
    //
    // Leading `for` is load-bearing, not decoration. Once plain `expression`
    // became a legal local_statement (for assignment_expression's sake), a
    // loop's pattern and an ordinary expression-statement started with the
    // exact same tokens: `(x)` could be a parenthesized_binding_pattern
    // (loop) or the start of a parenthesized_expression / assignment target
    // (statement), and only a token arbitrarily far ahead — `in` vs `=` vs
    // neither — tells them apart. Same shape of problem `let` solves for
    // destructuring bindings, same fix: a leading keyword commits the
    // parser to "pattern incoming" from token one, so there is nothing left
    // to fork on.
    //
    // One body form: `=> stmt`, same as lambdas and match arms. No separate
    // braced form is needed — `{` in statement position only ever opens a
    // block_expression (destructuring needs `let`, and there is no bare
    // record-literal expression), so `=> { a; b; }` already parses as one
    // statement that happens to be a block, with its value discarded since
    // loop_statement never captures a result. `=>` is still a hard resync
    // point after the iterable: it can't continue an expression, so a
    // truncated iterable can't eat the body and cascade into the rest of
    // the enclosing block.
    loop_statement: ($) =>
      seq(
        $.kw_for,
        field("pattern", $.binding_pattern),
        $.kw_in,
        field("iterable", $.expression),
        $.fat_arrow,
        field("body", $.local_statement),
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
