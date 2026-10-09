// Kippy grammar (Sketch C). Design rationale: notes/syntax.md
//
// decl = [pub] name [generics] [: type] [= value]
// The RHS decides the kind: record/choice/shape/distinct/alias/tag/intrinsic
// make it a type, anything else makes it a value.
//
// Separators: comma between items, semicolon after every statement.
// Arrows: => body follows, -> return, ->! effectful return.
// Locals: x = e introduces, ^x = e updates a mut.
// Fields: `name = value` everywhere; `:` always introduces a type.
// Records are nominal. Nameless patterns take the type from the scrutinee,
// `_ { ... }` from the expected type.

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
  "self",
  "Self",
];

// contextual: keywords only where a declaration can start
const DECL_KEYWORDS = [
  "alias",
  "distinct",
  "tag",
  "record",
  "choice",
  "shape",
  "intrinsic",
  "test",
  "expect",
  "use",
  "derive",
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
// 1.5, .5. No `1.`: it would swallow the dot of `1..<n`.
const DEC_POINT =
  `(?:${DEC_DIGITS}\\.${DEC_DIGITS}|\\.${DEC_DIGITS})`;
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

// `name = pattern` or punned `name`
function fieldPattern(fieldName, equals, valueRule) {
  return choice(seq(fieldName, equals, valueRule), fieldName);
}

function binary(lhs, op, rhs) {
  return seq(field("lhs", lhs), field("op", op), field("rhs", rhs));
}

// --- kippy-specific helpers --------------------------------------------------
function bracedCollection($, rule, separator) {
  return collection($.lbrace, $.rbrace, rule, separator);
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
  // DECL_KEYWORDS work as names (`a.tag`, `fn (test) => ...`); only `test`,
  // `use` and `derive` can't name a top-level binding, and the constructor
  // words can't name a type. Field names reserve nothing: `a.if`.
  reserved: {
    global: ($) => [
      ...KEYWORDS.filter((k) => !DECL_KEYWORDS.includes(k)).map((k) => $[`kw_${k}`]),
      $.pipe_hole,
      $.wildcard,
    ],
    field: () => [],
  },

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

  // No declared conflicts. Keep it that way.

  rules: {
    // --- source structure ---
    source_file: ($) => seq(opt($.module_declaration), repeat($.module_item)),

    module_declaration: ($) => seq($.kw_module, field("name", $.path)),

    module_item: ($) => withAttributes($, $._top_level_item),
    _top_level_item: ($) => choice($.use_statement, $.declaration),

    // `use foo { a, b }`; `pub use` re-exports
    use_statement: ($) =>
      seq(
        field("visibility", opt($.kw_pub)),
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
    // Brackets after the name are always type parameters: `List[Int] : S`
    // declares a parameter named Int, not an instantiation.
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

    // The only places record_type appears: here and as a choice variant
    // payload. Both are named, so there are no anonymous record types.
    record_constructor: ($) => seq($.kw_record, field("body", $.record_type)),

    choice_constructor: ($) =>
      seq($.kw_choice, field("body", bracedCollection($, $.choice_variant, $.comma))),

    // No `type` members — put the varying type in the parameter list.
    shape_constructor: ($) =>
      seq(
        $.kw_shape,
        opt(seq($.colon, field("parents", $.constraint_sum))),
        field("members", bracedCollection($, $.shape_method, $.comma)),
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
      seq($.lbracket, separated1($.identifier, $.comma), $.rbracket),

    // --- shapes ---
    // collapse[A] : fn(Self, A, fn(A, T) -> A) -> A where A : Eq = ...
    shape_method: ($) =>
      withAttributes(
        $,
        field("name", $.binding_name),
        optTypeParams($),
        $.colon,
        field("type_ann", $.type_expression),
        opt(field("constraints", $.constraint_clause)),
        opt(field("default", $.method_default)),
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
    // attribute record values are compile-time metadata, not typed values,
    // so they stay anonymous
    attribute_value: ($) =>
      choice(
        $.negative_literal,
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
        field("body", $.test_body),
      ),
    // like a block, minus the result
    test_body: ($) =>
      seq($.lbrace, many(seq($.local_statement, $.semicolon)), $.rbrace),
    // any statement position; resolver rejects it outside tests
    expect_statement: ($) => seq($.kw_expect, field("value", $.expression)),

    // --- names ---
    // both are identifiers; split so tooling can tell a field from a binding
    binding_name: ($) => $.identifier,
    field_name: ($) => reserved("field", $.identifier),

    // --- expressions ---
    expression: ($) =>
      choice(
        $.lambda_expression,
        $.if_expression,
        $._pipe_level,
      ),

    // postfix at pipe level: `xs |> f(__) case { ... } |> g(__)`.
    // `score > 10 case { ... }` matches the comparison, not the 10.
    case_expression: ($) =>
      seq(
        field("subject", $._pipe_level),
        $.kw_case,
        field("body", bracedCollection($, $.match_arm, $.comma)),
      ),

    value_slot: ($) => field("value", $.expression),
    if_then_value: ($) => field("then_value", $.expression),
    if_else_value: ($) => field("else_value", $.expression),
    lambda_body: ($) => field("body", $.expression),
    match_arm_value: ($) => field("value", $.expression),

    // `..base` in lists and record bodies. A bare `..` is only accepted by the
    // resolver in a binding target: `User { name, .. } = user`.
    spread_element: ($) => seq($.rest_op, opt(field("base", $.expression))),

    // --- operator ladder (loosest to tightest) ---
    // Hidden levels; a node only appears when its operator does.
    _pipe_level: ($) =>
      choice(
        alias($.pipe_binary, $.binary_expression),
        $.case_expression,
        $._or_level,
      ),
    pipe_binary: ($) => binary($._pipe_level, $.pipe, $._or_level),

    _or_level: ($) =>
      choice(alias($.or_binary, $.binary_expression), $._and_level),
    or_binary: ($) => binary($._or_level, $.or_op, $._and_level),

    _and_level: ($) =>
      choice(alias($.and_binary, $.binary_expression), $._compare_level),
    and_binary: ($) => binary($._and_level, $.and_op, $._compare_level),

    // non-associative: `a < b < c` doesn't parse
    _compare_level: ($) =>
      choice(alias($.compare_binary, $.binary_expression), $._range_level),
    compare_binary: ($) =>
      binary(
        $._range_level,
        choice($.le_op, $.ge_op, $.eq_op, $.ne_op, $.lt_op, $.gt_op),
        $._range_level,
      ),

    // `a..<b` excludes b, `a..=b` includes it. Non-associative, both ends
    // required, integers or Char. Value is the prelude's Range[T] record.
    _range_level: ($) => choice($.range_expression, $._add_level),
    range_expression: ($) =>
      binary(
        $._add_level,
        choice($.range_excl_op, $.range_incl_op),
        $._add_level,
      ),

    _add_level: ($) =>
      choice(alias($.add_binary, $.binary_expression), $._mul_level),
    add_binary: ($) =>
      binary($._add_level, choice($.plus_op, $.minus_op), $._mul_level),

    _mul_level: ($) =>
      choice(alias($.mul_binary, $.binary_expression), $._unary_level),
    mul_binary: ($) =>
      binary(
        $._mul_level,
        choice($.star_op, $.slash_op, $.kw_mod),
        $._unary_level,
      ),

    // `not` binds tightly, same as `-`. `not a == b` is `(not a) == b`.
    _unary_level: ($) => choice($.unary_expression, $._postfix_level),
    unary_expression: ($) =>
      seq(
        field("op", choice($.minus_op, $.kw_not)),
        field("operand", $._unary_level),
      ),

    // --- postfix chain ---
    _postfix_level: ($) => choice($.postfix_expression, $._primary),
    postfix_expression: ($) =>
      prec.left(
        seq(
          field("base", $._primary),
          repeat1(choice(
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
        opt(separated1(field("arg", $.expression), $.comma)),
        $.rparen,
      ),
    // type application if the base has type parameters (`id[Int](x)`, one
    // arg each), otherwise indexing (`xs[i]`, one arg). Resolver decides.
    index_suffix: ($) =>
      seq(
        $.lbracket,
        separated1(field("index", $.expression), $.comma),
        $.rbracket,
      ),
    field_suffix: ($) => seq($.dot, field("field", $.field_name)),

    // `t.0.1`: float_literal isn't valid after `dot`
    tuple_index_suffix: ($) => seq($.dot, field("index", $.tuple_index)),
    tuple_index: () => token.immediate(new RustRegex("[0-9]+")),

    // @ finds the implementation by type; @Shape::method disambiguates a
    // method name declared by two different shapes.
    method_suffix: ($) =>
      seq(
        $.at_sign,
        field("method", $.path),
      ),

    // Type base: construction. `_` base: construction of the expected type,
    // e.g. `Task : Display = _ { show = ... }`. Value base: functional update.
    record_suffix: ($) => field("body", $.record_body),

    // --- primary ---
    _primary: ($) =>
      choice(
        $.block_expression,
        $._literal,
        $.path,
        $.placeholder,
        $.pipe_hole,
        $.wildcard, // binding target or `_ { ... }` only
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

    // suffix only; a bare `{` is a block
    record_body: ($) => bracedCollection($, $.record_field, $.comma),
    record_field: ($) =>
      choice(
        seq(field("name", $.field_name), $.equals, $.value_slot),
        field("name", $.field_name), // punning: `{ x }` == `{ x = x }`
        $.spread_element,
      ),

    // --- control flow ---

    block_expression: ($) =>
      seq(
        $.lbrace,
        many(seq($.local_statement, $.semicolon)),
        opt(field("result", $.expression)),
        $.rbrace,
      ),

    // x = 10;  mut total : Int = 0;  (a, b) = pair;  User { name, .. } = u;
    // Cover grammar: the target parses as an expression; the resolver checks
    // it's an irrefutable pattern. Record destructuring names the type.
    // `mut`: the name takes successive values, not shared mutable storage.
    local_binding: ($) =>
      seq(
        opt(choice($.kw_rec, $.kw_mut)),
        field("target", $._postfix_level),
        opt(seq($.colon, field("type_ann", $.type_expression))),
        $.equals,
        $.value_slot,
      ),

    // ^total = total + x;  ^state.tick = state.tick + 1;  ^xs[i] = v;
    // No expression starts with `^`, so the first token decides.
    update_statement: ($) =>
      seq(
        $.caret,
        field("target", $._postfix_level),
        $.equals,
        $.value_slot,
      ),

    local_statement: ($) =>
      choice(
        $.local_binding,
        $.update_statement,
        $.loop_statement,
        $.expect_statement,
        $.expression,
      ),

    loop_statement: ($) =>
      seq(
        $.kw_for,
        field("pattern", $.binding_pattern),
        $.kw_in,
        field("iterable", $.expression),
        $.fat_arrow,
        field("body", $.local_statement),
      ),

    // no `else`: then-branch must be `()`
    if_expression: ($) =>
      prec.right(seq(
        $.kw_if,
        field("condition", $._pipe_level),
        $.kw_then,
        $.if_then_value,
        opt(seq($.kw_else, $.if_else_value)),
      )),

    // `else =>` is not `_ =>`: the totality checker treats else as deliberate
    // incompleteness and names the variants it swallows.
    match_arm: ($) =>
      choice(
        seq(field("pattern", $.pattern), $.fat_arrow, $.match_arm_value),
        seq($.kw_else, $.fat_arrow, $.match_arm_value),
      ),

    // fn (a: Int, b: Int) -> Int => a + b; both annotations optional
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
    // guards only at the top of an arm
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
        $.range_pattern,
        $._pattern_literal,
        $.negative_literal,
        $.unit_pattern,
        $.wildcard_pattern,
        $.path_pattern,
        $.list_pattern,
        $.tuple_pattern,
        $.record_pattern,
        $.parenthesized_pattern,
      ),

    // Some(x)  Move { dx, dy }  User { name, .. }
    path_pattern: ($) =>
      seq(
        field("constructor", $.path),
        opt(choice(
          bracketedWithRest(
            $.lparen,
            $.rparen,
            field("payload", $.unguarded_pattern),
            $.comma,
            $.rest_pattern,
          ),
          field("fields", $.record_pattern),
        )),
      ),

    // no interpolation in patterns
    _pattern_literal: ($) =>
      choice(
        $.percent_literal,
        $.int_literal,
        $.float_literal,
        $.char_literal,
        $.static_text,
      ),

    // -1  -0.5  -10%
    negative_literal: ($) =>
      seq(
        $.minus_op,
        field("value", choice($.int_literal, $.float_literal, $.percent_literal)),
      ),

    // 'a'..='z'  0..<10  -5..=5
    range_pattern: ($) =>
      seq(
        field("start", $.range_bound),
        field("op", choice($.range_excl_op, $.range_incl_op)),
        field("end", $.range_bound),
      ),
    range_bound: ($) =>
      choice($.int_literal, $.negative_literal, $.char_literal),

    wildcard_pattern: ($) => $.wildcard,
    unit_pattern: ($) => seq($.lparen, $.rparen),

    list_pattern: ($) =>
      bracketedWithRest(
        $.lbracket,
        $.rbracket,
        $.unguarded_pattern,
        $.comma,
        $.rest_pattern,
      ),
    tuple_pattern: ($) => tuple($, $.unguarded_pattern),
    parenthesized_pattern: ($) =>
      seq($.lparen, field("value", $.unguarded_pattern), $.rparen),
    // nameless: type from the scrutinee; not against a choice
    record_pattern: ($) =>
      bracketedWithRest(
        $.lbrace,
        $.rbrace,
        $.record_pattern_field,
        $.comma,
        $.rest_op,
      ),
    record_pattern_field: ($) => fieldPattern($.field_name, $.equals, $.unguarded_pattern),
    // `..rest` or bare `..`, last only
    rest_pattern: ($) => seq($.rest_op, opt(field("binding", $.identifier))),

    // lambda params and `for`; irrefutable shapes only
    binding_pattern: ($) =>
      choice(
        $.unit_pattern,
        $.wildcard_pattern,
        $.identifier,
        $.binding_tuple_pattern,
        $.binding_record_pattern,
        $.binding_named_record_pattern,
        $.parenthesized_binding_pattern,
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
    // fn (User { name, .. }) => ...
    binding_named_record_pattern: ($) =>
      seq(field("type", $.path), field("fields", $.binding_record_pattern)),
    binding_record_pattern_field: ($) =>
      fieldPattern($.field_name, $.equals, $.binding_pattern),

    // --- types ---
    type_expression: ($) =>
      choice($.base_type, seq($.ellipsis, field("item", $.base_type))),
    base_type: ($) =>
      choice($.function_type, $.wildcard_type, $._concrete_type_head),

    // no record_type here: records are nominal
    _concrete_type_head: ($) =>
      choice(
        $.path_or_applied,
        $.unit_type,
        $.tuple_type,
        $.parenthesized_type,
      ),

    path_or_applied: ($) =>
      seq(
        field("constructor", $.path),
        opt(field("args", $.type_argument_list)),
      ),
    type_argument_list: ($) =>
      seq($.lbracket, separated1($.type_expression, $.comma), $.rbracket),

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
    // T : Eq + Into[Int]. Also derive and shape parents.
    constraint_sum: ($) =>
      prec.left(seq(
        field("shape", $.path_or_applied),
        many(seq($.plus_op, field("shape", $.path_or_applied))),
      )),

    // --- literals ---
    _literal: ($) =>
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
      token(new RustRegex(`'(?:[^'\\\\\\r\\n]|\\\\${ESCAPE_BODY})'`)),

    // static_text is text minus interpolation, for compile-time constants.
    // Immediate tokens after the opening quote: no comments or newlines inside.
    text: ($) =>
      seq(
        $.quote,
        many(choice($.text_content, $.escape_sequence, $.interpolation)),
        alias($.close_quote, $.quote),
      ),
    text_content: ($) =>
      token.immediate(prec(1, new RustRegex('[^"\\\\\\r\\n]+'))),
    static_text: ($) =>
      seq(
        $.quote,
        many(choice(
          alias($.text_content, $.static_text_content),
          $.escape_sequence,
        )),
        alias($.close_quote, $.quote),
      ),
    interpolation: ($) => seq($.interpolation_start, $.expression, $.rparen),
    interpolation_start: ($) =>
      token.immediate(new RustRegex("\\\\\\(")), // \(
    escape_sequence: ($) =>
      token.immediate(new RustRegex(`\\\\${ESCAPE_BODY}`)),

    // --- comments ---
    // NON-NESTING: `/* a /* b */ c */` ends at the first `*/`. Nesting needs
    // an external scanner.
    line_comment: (_) => token(new RustRegex("//[^\\n]*")),
    block_comment: (_) =>
      token(seq("/*", /[^*]*\*+([^/*][^*]*\*+)*/, "/")),

    // --- identifiers, paths, operators ---
    identifier: ($) =>
      token(new RustRegex("[_\\p{ID_Start}][\\p{ID_Continue}]*")),
    // `self` is the current module only; `Self` works in types and values
    path_head: ($) => choice($.identifier, $.kw_self, $.kw_Self),
    path: ($) => seq($.path_head, repeat(seq($.module_sep, $.identifier))),
    // one-argument lambda hole; its scope is the nearest enclosing call
    // argument (resolver rule), so `zip(map(a, $ + 1), map(b, $ * 2))` is two
    // lambdas. `$.field` parses as placeholder + field_suffix.
    placeholder: ($) => token("$"),
    // pipeline hole: `xs |> map(__, $ * 2)`. Every `|>` RHS contains exactly
    // one. Reserved, so it can't be bound.
    pipe_hole: ($) => "__",
    wildcard: ($) => "_",
    ellipsis: ($) => "...",
    rest_op: ($) => "..",
    range_excl_op: () => token("..<"),
    range_incl_op: () => token("..="),

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
    close_quote: () => token.immediate('"'),
    comma: () => ",",
    colon: () => ":",
    equals: () => "=",
    semicolon: () => ";",
    dot: () => ".", // not immediate, so chains can continue on the next line
    module_sep: () => token.immediate("::"),
    at_sign: () => "@",
    hash_sign: () => "#",
    caret: () => "^", // update marker: ^x = e

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
