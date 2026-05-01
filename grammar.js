const PREC = {
  PIPE: 1,
  OR: 2,
  AND: 3,
  COMPARE: 4,
  ADD: 5,
  MUL: 6,
  UNARY: 7,
  POSTFIX: 8,
};

const KEYWORDS = [
  "pub",
  "let",
  "rec",
  "alias",
  "distinct",
  "tag",
  "record",
  "choice",
  "expect",
  "if",
  "then",
  "else",
  "match",
  "in",
  "where",
  "with",
  "shape",
  "module",
  "use",
  "build",
  "type",
  "fit",
  "derive",
  "sig",
  "fn",
  "test",
  "or",
  "and",
  "not",
  "mod",
  "as",
  "self",
  "Self",
];

const DEC_DIGITS = "(?:[0-9]|[0-9][0-9_]*[0-9])";
const HEX_DIGITS = "(?:[0-9a-fA-F]|[0-9a-fA-F][0-9a-fA-F_]*[0-9a-fA-F])";
const OCT_DIGITS = "(?:[0-7]|[0-7][0-7_]*[0-7])";
const BIN_DIGITS = "(?:[01]|[01][01_]*[01])";
const INT_SUFFIX = "(?:U8|U16|U32|U64|I8|I16|I32|I64)?";
const FLOAT_SUFFIX = "(?:F32|F64)?";
const PERCENT = "%";
const EXPONENT = "(?:[eE][+-]?(?:[0-9]|[0-9][0-9_]*[0-9]))";
const CHAR_ESCAPE =
  `(?:[nrt0\\\\'"bfv]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})`;
const LINE_SPLICE = "\\r?\\n[ \\t]*";
const STRING_ESCAPE =
  `(?:u\\([0-9A-Fa-f]{1,8}\\)|x[0-9A-Fa-f]{2}|[\\\\'"ntrbfv]|${LINE_SPLICE})`;

const opt = optional;
const many = repeat;

// Leading-only newline absorber. Trailing newlines are picked up by the next
// `_` in the seq chain or by the surrounding closer's own newline handling.
function _($, rule) {
  return seq(many($.newline), rule);
}

function sep1(rule, separator) {
  return seq(rule, many(seq(separator, rule)));
}

function separated1($, rule, separator) {
  return seq(rule, many(seq(separator, rule)), opt(separator));
}

function delimited($, open, close, interior) {
  return seq(open, many($.newline), opt(interior), many($.newline), close);
}

function semiSep($) {
  return choice($.semicolon, repeat1($.newline));
}

function layoutExpr($, name = "value") {
  return field(name, $.expression);
}

function layoutType($, name = "type") {
  return field(name, $.type_expression);
}

function fileBody($, header, item) {
  return seq(opt(header), many($.newline), repeat(seq(item, many($.newline))));
}

function separatedWithOptionalRest(item, separator, rest) {
  return opt(
    choice(seq(sep1(item, separator), opt(seq(separator, rest))), rest),
  );
}

function fieldPattern($, fieldName, colon, valueRule) {
  return choice(seq(fieldName, _($, colon), valueRule), fieldName);
}

function looseSeparated2Plus($, rule, separator) {
  return seq(rule, separator, rule, many(seq(separator, rule)), opt(separator));
}

function collection($, open, close, item, separator) {
  return delimited($, open, close, separated1($, item, separator));
}

function tuple($, open, close, item, separator) {
  return delimited(
    $,
    open,
    close,
    looseSeparated2Plus($, field("element", item), separator),
  );
}

function flexCollection($, open, close, rule, separator) {
  const body = seq(rule, many(seq(separator, rule)), opt(separator));
  return seq(open, many($.newline), opt(body), many($.newline), close);
}

function bracedCollection($, rule, separator) {
  return flexCollection($, $.lbrace, $.rbrace, rule, separator);
}

function withPayloads($, nameRule, payloadRule) {
  return seq(
    nameRule,
    _($, $.kw_with),
    field("payload", payloadRule),
    many(seq(_($, $.comma), field("payload", payloadRule))),
  );
}

function parameterList($, paramRule) {
  return seq(
    field("param", paramRule),
    many(seq(_($, $.comma), field("param", paramRule))),
    opt(_($, $.comma)),
  );
}

function bareBinding($, nameRule) {
  return seq(
    field("name", nameRule),
    opt(seq(_($, $.colon), field("type_ann", $.type_body))),
    _($, $.equals),
    $.value_slot,
  );
}

function attributePrefix($) {
  return many(seq(field("attribute", $.attribute), many($.newline)));
}

function visibility_modifier($) {
  return opt(seq($.kw_pub, many($.newline)));
}

function buildExpressionLadder(suffix, baseRule) {
  const name = (level) => `${level}${suffix}`;
  return {
    [name("pipe_expression")]: ($) =>
      prec.left(
        PREC.PIPE,
        seq(
          field("lhs", $[name("or_expression")]),
          many(seq(_($, $.pipe), field("rhs", $[name("or_expression")]))),
        ),
      ),
    [name("or_expression")]: ($) =>
      prec.left(
        PREC.OR,
        seq(
          field("lhs", $[name("and_expression")]),
          many(seq(_($, $.or_op), field("rhs", $[name("and_expression")]))),
        ),
      ),
    [name("and_expression")]: ($) =>
      prec.left(
        PREC.AND,
        seq(
          field("lhs", $[name("compare_expression")]),
          many(
            seq(_($, $.and_op), field("rhs", $[name("compare_expression")])),
          ),
        ),
      ),
    [name("compare_expression")]: ($) =>
      prec.left(
        PREC.COMPARE,
        seq(
          field("lhs", $[name("add_expression")]),
          opt(
            seq(
              field(
                "op",
                _(
                  $,
                  choice($.le_op, $.ge_op, $.eq_op, $.ne_op, $.lt_op, $.gt_op),
                ),
              ),
              field("rhs", $[name("add_expression")]),
            ),
          ),
        ),
      ),
    [name("add_expression")]: ($) =>
      prec.left(
        PREC.ADD,
        seq(
          field("lhs", $[name("mul_expression")]),
          many(
            seq(
              field("op", _($, choice($.plus_op, $.minus_op))),
              field("rhs", $[name("mul_expression")]),
            ),
          ),
        ),
      ),
    [name("mul_expression")]: ($) =>
      prec.left(
        PREC.MUL,
        seq(
          field("lhs", $[name("unary_expression")]),
          many(
            seq(
              field("op", _($, choice($.star_op, $.slash_op, $.kw_mod))),
              field("rhs", $[name("unary_expression")]),
            ),
          ),
        ),
      ),
    [name("unary_expression")]: ($) =>
      choice(
        prec.right(
          PREC.UNARY,
          seq(
            field("op", choice($.minus_op, $.kw_not)),
            many($.newline),
            field("operand", $[name("unary_expression")]),
          ),
        ),
        $[baseRule],
      ),
  };
}

const expressionRules = buildExpressionLadder("", "application_expression");
const noBraceExpressionRules = buildExpressionLadder(
  "_no_brace",
  "application_expression_no_brace",
);

function buildExpressionBottom(suffix, inlineChoices, postfixSuffixes) {
  const s = (name) => `${name}${suffix}`;
  return {
    [s("application_expression")]: ($) =>
      prec.right(
        PREC.POSTFIX,
        choice(
          seq(
            field("callee", $[s("postfix_expression")]),
            _($, $.kw_with),
            field("arg", $.call_argument),
            many(seq(_($, $.comma), field("arg", $.call_argument))),
            opt(_($, $.comma)),
          ),
          $[s("postfix_expression")],
        ),
      ),
    [s("postfix_expression")]: ($) =>
      prec.left(
        PREC.POSTFIX,
        seq(
          field("base", $[s("primary_expression")]),
          many(choice(...postfixSuffixes($))),
        ),
      ),
    [s("primary_expression")]: ($) => choice(...inlineChoices($)),
  };
}

const INLINE_ALL = (
  $,
) => [
  $.record_builder,
  $.literal,
  $.path,
  $.placeholder,
  $.unit_expression,
  $.list_expression,
  $.map_expression,
  $.record_expression,
  $.tuple_expression,
  $.parenthesized_expression,
];
const INLINE_NO_BRACE = (
  $,
) => [
  $.literal,
  $.path,
  $.placeholder,
  $.unit_expression,
  $.list_expression,
  $.map_expression,
  $.tuple_expression,
  $.parenthesized_expression,
];
const POSTFIX_ALL = (
  $,
) => [
  $.record_suffix,
  $.call_suffix,
  $.index_suffix,
  $.field_suffix,
  $.try_op,
  $.method_suffix,
];
const POSTFIX_NO_BRACE = (
  $,
) => [$.call_suffix, $.index_suffix, $.field_suffix, $.try_op, $.method_suffix];

const expressionBottom = buildExpressionBottom("", INLINE_ALL, POSTFIX_ALL);
const noBraceExpressionBottom = buildExpressionBottom(
  "_no_brace",
  INLINE_NO_BRACE,
  POSTFIX_NO_BRACE,
);

module.exports = grammar({
  name: "kippy",
  word: ($) => $.identifier,
  reserved: { global: ($) => KEYWORDS.map((k) => $[`kw_${k}`]) },
  extras: (
    $,
  ) => [new RustRegex("[ \\t\\r\\f]+"), $.line_comment, $.block_comment],
  supertypes: ($) => [$.expression],
  inline: (
    $,
  ) => [
    // original inlines
    $.value_slot,
    $.match_arm_value,
    $.method_body,
    $.lambda_body,
    $.let_body,
    $.if_then_value,
    $.if_else_value,
    $.statement_expression,
    // trivial wrapper rules — pure delegation, no node-name value
    $.module_item,
    $.declaration,
    $.fit_member,
    $.shape_member,
    $.test_statement,
    $.list_item,
    $.unguarded_pattern,
    $.binding_name,
    $.field_name,
    $.type_member_name,
    $.path_head,
    $.type_body,
    $.call_argument,
    // entire `_no_brace` ladder — same shape as the regular ladder, only
    // exists to forbid `record_suffix` after match/if subjects. Inlining
    // collapses parallel state machines without changing what parses.
    $.pipe_expression_no_brace,
    $.or_expression_no_brace,
    $.and_expression_no_brace,
    $.compare_expression_no_brace,
    $.add_expression_no_brace,
    $.mul_expression_no_brace,
    $.unary_expression_no_brace,
    $.application_expression_no_brace,
    $.postfix_expression_no_brace,
    $.primary_expression_no_brace,
  ],

  rules: {
    source_file: ($) => fileBody($, $.module_declaration, $.module_item),
    module_item: ($) => choice($.use_statement, $.declaration),
    declaration: ($) =>
      choice(
        $.alias_declaration,
        $.distinct_declaration,
        $.tag_declaration,
        $.record_declaration,
        $.choice_declaration,
        $.derive_declaration,
        $.signature,
        $.value_declaration,
        $.shape_declaration,
        $.test_declaration,
        $.implementation,
      ),

    use_statement: ($) =>
      seq(
        attributePrefix($),
        $.kw_use,
        _($, field("module", $.path)),
        opt(seq(_($, $.kw_as), field("alias", $.identifier))),
        opt(seq(_($, $.dot), field("imports", $.import_set))),
      ),
    import_set: ($) =>
      collection($, $.lbrace, $.rbrace, $.import_item, _($, $.comma)),
    import_item: ($) =>
      seq(
        field("name", $.identifier),
        opt(seq(_($, $.kw_as), field("alias", $.identifier))),
      ),
    module_declaration: ($) => seq($.kw_module, _($, field("name", $.path))),

    alias_declaration: ($) =>
      seq(
        attributePrefix($),
        visibility_modifier($),
        $.kw_alias,
        _($, field("name", $.binding_name)),
        _($, $.equals),
        field("body", $.type_expression),
      ),
    distinct_declaration: ($) =>
      seq(
        attributePrefix($),
        visibility_modifier($),
        $.kw_distinct,
        _($, field("name", $.binding_name)),
        opt(field("type_params", $.type_parameter_list)),
        opt(seq(_($, $.equals), field("body", $.type_expression))),
      ),
    tag_declaration: ($) =>
      seq(
        attributePrefix($),
        visibility_modifier($),
        $.kw_tag,
        _($, field("name", $.binding_name)),
        opt(field("type_params", $.type_parameter_list)),
      ),
    record_declaration: ($) =>
      seq(
        attributePrefix($),
        visibility_modifier($),
        $.kw_record,
        _($, field("name", $.binding_name)),
        opt(field("type_params", $.type_parameter_list)),
        _($, field("body", $.record_type)),
      ),
    choice_declaration: ($) =>
      seq(
        attributePrefix($),
        visibility_modifier($),
        $.kw_choice,
        _($, field("name", $.binding_name)),
        opt(field("type_params", $.type_parameter_list)),
        _($, bracedCollection($, $.choice_variant, semiSep($))),
      ),
    choice_variant: ($) =>
      seq(
        attributePrefix($),
        choice(
          withPayloads($, field("name", $.identifier), $.type_expression),
          seq(
            field("name", $.identifier),
            _($, field("payload", $.record_type)),
          ),
          field("name", $.identifier),
        ),
      ),

    type_parameter_list: ($) =>
      collection($, $.lbracket, $.rbracket, $.identifier, _($, $.comma)),
    shape_method: ($) =>
      seq(
        attributePrefix($),
        field("name", $.binding_name),
        _($, $.colon),
        field("type_ann", $.type_body),
        opt(field("default", $.method_default)),
        opt(field("constraints", $.constraint_clause)),
      ),
    method_default: ($) => seq(_($, $.equals), $.value_slot),
    signature: ($) =>
      seq(
        attributePrefix($),
        visibility_modifier($),
        $.kw_sig,
        _($, field("name", $.identifier)),
        _($, $.colon),
        field("type_ann", $.type_body),
        opt(field("constraints", $.constraint_clause)),
      ),
    value_declaration: ($) =>
      seq(
        attributePrefix($),
        visibility_modifier($),
        $.kw_let,
        opt(_($, $.kw_rec)),
        bareBinding($, $.binding_name),
      ),

    attribute: ($) =>
      seq(
        $.hash_sign,
        field("path", $.path),
        opt(field("args", $.attribute_arguments_inline)),
      ),
    attribute_arguments_inline: ($) =>
      collection($, $.lparen, $.rparen, $.attribute_argument, _($, $.comma)),
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
        seq($.lparen, _($, $.attribute_value), $.rparen),
      ),
    attribute_list_value: ($) =>
      collection($, $.lbracket, $.rbracket, $.attribute_value, semiSep($)),
    attribute_record_value: ($) =>
      bracedCollection($, $.attribute_record_field, semiSep($)),
    attribute_record_field: ($) =>
      seq(
        field("name", $.field_name),
        _($, $.equals),
        field("value", $.attribute_value),
      ),
    attribute_argument: ($) =>
      choice(
        $.attribute_value,
        seq(
          field("name", $.identifier),
          _($, $.equals),
          field("value", $.attribute_value),
        ),
      ),

    implementation: ($) =>
      seq(
        attributePrefix($),
        visibility_modifier($),
        $.kw_fit,
        opt(field("type_params", $.type_parameter_list)),
        _($, field("type", $.impl_type_head)),
        _($, $.colon),
        _($, field("shape", $.path)),
        opt(field("constraints", $.constraint_clause)),
        _($, bracedCollection($, $.fit_member, semiSep($))),
      ),
    derive_declaration: ($) =>
      seq(
        attributePrefix($),
        visibility_modifier($),
        $.kw_derive,
        opt(field("type_params", $.type_parameter_list)),
        _($, field("type", $.impl_type_head)),
        _($, $.colon),
        _($, field("shape", $.path)),
        opt(field("constraints", $.constraint_clause)),
      ),
    impl_type_head: ($) =>
      choice(
        $.applied_type,
        $.path,
        $.self_type,
        $.unit_type,
        $.tuple_type,
        $.record_type,
        $.parenthesized_type,
      ),
    fit_member: ($) => choice($.fit_type_def, $.fit_method),
    fit_type_def: ($) =>
      seq(
        attributePrefix($),
        _($, $.kw_type),
        field("name", $.type_member_name),
        _($, $.equals),
        field("value", $.type_body),
      ),
    fit_method: ($) =>
      seq(
        attributePrefix($),
        field("name", $.identifier),
        opt(field("parameters", $.method_parameter_list)),
        _($, $.fat_arrow),
        $.method_body,
      ),
    method_parameter_list: ($) => parameterList($, $.binding_pattern),

    shape_declaration: ($) =>
      seq(
        attributePrefix($),
        visibility_modifier($),
        $.kw_shape,
        _($, field("name", $.binding_name)),
        opt(field("type_params", $.type_parameter_list)),
        opt(field("parents", $.shape_parents)),
        _($, bracedCollection($, $.shape_member, semiSep($))),
      ),
    shape_member: ($) => choice($.shape_type_decl, $.shape_method),
    shape_type_decl: ($) =>
      seq(
        attributePrefix($),
        _($, $.kw_type),
        field("name", $.type_member_name),
      ),
    shape_parents: ($) =>
      seq(
        _($, $.colon),
        sep1(field("parent", choice($.applied_type, $.path)), _($, $.comma)),
      ),

    expect_statement: ($) =>
      seq($.kw_expect, _($, field("value", $.statement_expression))),
    test_declaration: ($) =>
      seq(
        attributePrefix($),
        _($, $.kw_test),
        _($, field("name", $.static_text)),
        _($, bracedCollection($, $.test_statement, semiSep($))),
      ),
    test_statement: ($) =>
      choice($.test_binding, $.test_value_declaration, $.expect_statement),
    test_binding: ($) => seq($.kw_let, _($, $.binding_core)),
    test_value_declaration: ($) => bareBinding($, $.binding_name),
    binding_core: ($) =>
      seq(
        opt(_($, $.kw_rec)),
        field("pattern", $.binding_pattern),
        opt(seq(_($, $.colon), field("type_ann", $.type_body))),
        _($, $.equals),
        $.value_slot,
      ),

    binding_name: ($) => reserved("global", $.identifier),
    type_member_name: ($) => reserved("global", $.identifier),
    expression: ($) =>
      choice(
        $.lambda_expression,
        $.if_expression,
        $.let_expression,
        $.match_expression,
        $.pipe_expression,
      ),
    statement_expression: ($) =>
      choice(
        $.lambda_expression,
        $.if_expression,
        $.let_expression,
        $.match_expression,
        $.pipe_expression,
      ),
    call_argument: ($) => $.postfix_expression,
    spread_element: ($) => seq($.rest_op, _($, field("base", $.expression))),
    value_slot: ($) => field("value", $.statement_expression),
    if_then_value: ($) => layoutExpr($, "then_value"),
    if_else_value: ($) => layoutExpr($, "else_value"),
    let_body: ($) => layoutExpr($, "body"),
    lambda_body: ($) => layoutExpr($, "body"),
    method_body: ($) => layoutExpr($, "body"),
    match_arm_value: ($) => layoutExpr($, "value"),

    ...expressionRules,
    ...noBraceExpressionRules,
    ...expressionBottom,
    ...noBraceExpressionBottom,

    call_suffix: ($) => seq($.lparen, many($.newline), $.rparen),
    index_suffix: ($) =>
      seq($.lbracket, _($, field("index", $.expression)), $.rbracket),
    field_suffix: ($) => seq($.dot, field("field", $.field_name)),
    method_suffix: ($) =>
      seq(
        $.at_sign,
        field("method", $.identifier),
        opt(seq(_($, $.colon), field("shape", $.path))),
      ),
    record_suffix: ($) => field("body", $.record_body),

    unit_expression: ($) => seq($.lparen, many($.newline), $.rparen),
    list_expression: ($) =>
      collection($, $.lbracket, $.rbracket, $.list_item, semiSep($)),
    list_item: ($) => choice($.expression, $.spread_element),
    map_expression: ($) =>
      collection($, $.lbracket_map, $.rbracket, $.map_entry, semiSep($)),
    map_entry: ($) =>
      seq(field("key", $.expression), _($, $.fat_arrow), $.value_slot),
    record_expression: ($) => $.record_body,
    record_builder: ($) =>
      seq($.kw_build, _($, field("builder", $.path)), $.builder_body),
    record_body: ($) => bracedCollection($, $.record_field, semiSep($)),
    builder_body: ($) => bracedCollection($, $.builder_field, semiSep($)),
    record_field: ($) =>
      choice(
        seq(field("name", $.field_name), _($, $.equals), $.value_slot),
        $.spread_element,
      ),
    builder_field: ($) =>
      seq(field("name", $.field_name), _($, $.left_arrow), $.value_slot),
    field_name: ($) => reserved("global", $.identifier),
    tuple_expression: ($) =>
      tuple($, $.lparen_hash, $.rparen, $.expression, _($, $.semicolon)),
    parenthesized_expression: ($) =>
      seq($.lparen, _($, field("value", $.expression)), $.rparen),

    let_expression: ($) =>
      prec.right(
        seq(
          $.kw_let,
          _($, separated1($, $.binding_core, semiSep($))),
          _($, $.kw_in),
          $.let_body,
        ),
      ),
    match_expression: ($) =>
      prec.right(
        seq(
          $.kw_match,
          _($, field("subject", $.pipe_expression_no_brace)),
          field("body", bracedCollection($, $.match_arm, semiSep($))),
        ),
      ),
    match_arm: ($) =>
      seq(field("pattern", $.pattern), _($, $.arrow), $.match_arm_value),
    lambda_parameters: ($) => parameterList($, $.binding_pattern),
    lambda_expression: ($) =>
      prec.right(
        seq(
          $.kw_fn,
          _($, $.lambda_parameters),
          _($, $.fat_arrow),
          $.lambda_body,
        ),
      ),
    if_expression: ($) =>
      prec.right(
        seq(
          $.kw_if,
          _($, field("condition", $.pipe_expression_no_brace)),
          _($, $.kw_then),
          $.if_then_value,
          _($, $.kw_else),
          $.if_else_value,
        ),
      ),

    pattern: ($) =>
      seq(
        $.unguarded_pattern,
        opt(seq(_($, $.kw_if), field("guard", $.expression))),
      ),
    unguarded_pattern: ($) => $.or_pattern,
    binding_pattern: ($) =>
      choice(
        $.unit_pattern,
        $.wildcard_pattern,
        $.identifier,
        $.binding_list_pattern,
        $.binding_tuple_pattern,
        $.binding_record_pattern,
      ),
    or_pattern: ($) => prec.left(sep1($.as_pattern, _($, $.bar))),
    as_pattern: ($) =>
      prec.right(
        1,
        choice(
          seq($.atomic_pattern, _($, $.kw_as), field("binding", $.identifier)),
          $.atomic_pattern,
        ),
      ),
    atomic_pattern: ($) =>
      choice(
        $.literal,
        $.wildcard_pattern,
        $.path_pattern,
        $.list_pattern,
        $.tuple_pattern,
        $.record_pattern,
        seq($.lparen, _($, $.pattern), $.rparen),
      ),
    path_pattern: ($) =>
      choice(
        withPayloads($, field("constructor", $.path), $.tag_payload_pattern),
        field("constructor", $.path),
      ),
    wildcard_pattern: ($) => $.wildcard,
    unit_pattern: ($) => seq($.lparen, many($.newline), $.rparen),
    binding_list_pattern: ($) =>
      seq(
        $.lbracket,
        _(
          $,
          separatedWithOptionalRest(
            $.binding_pattern,
            semiSep($),
            $.rest_pattern,
          ),
        ),
        $.rbracket,
      ),
    binding_tuple_pattern: ($) =>
      tuple($, $.lparen_hash, $.rparen, $.binding_pattern, _($, $.semicolon)),
    binding_record_pattern: ($) =>
      seq(
        $.lbrace,
        _(
          $,
          separatedWithOptionalRest(
            $.binding_record_pattern_field,
            semiSep($),
            $.rest_op,
          ),
        ),
        $.rbrace,
      ),
    binding_record_pattern_field: ($) =>
      fieldPattern($, $.field_name, $.colon, $.binding_pattern),
    tag_payload_pattern: ($) =>
      choice(
        $.literal,
        $.wildcard_pattern,
        $.path,
        $.list_pattern,
        $.tuple_pattern,
        $.record_pattern,
        seq($.lparen, _($, $.pattern), $.rparen),
      ),
    list_pattern: ($) =>
      seq(
        $.lbracket,
        _($, separatedWithOptionalRest($.pattern, semiSep($), $.rest_pattern)),
        $.rbracket,
      ),
    rest_pattern: ($) => seq($.rest_op, _($, field("binding", $.identifier))),
    tuple_pattern: ($) =>
      tuple($, $.lparen_hash, $.rparen, $.pattern, _($, $.semicolon)),
    record_pattern: ($) =>
      seq(
        $.lbrace,
        _(
          $,
          separatedWithOptionalRest(
            $.record_pattern_field,
            semiSep($),
            $.rest_op,
          ),
        ),
        $.rbrace,
      ),
    record_pattern_field: ($) =>
      fieldPattern($, $.field_name, $.colon, $.pattern),

    base_type: ($) =>
      choice(
        $.function_type,
        $.applied_type,
        $.path,
        $.self_type,
        $.unit_type,
        $.wildcard_type,
        $.tuple_type,
        $.record_type,
        $.parenthesized_type,
      ),
    type_expression: ($) =>
      choice($.base_type, seq($.ellipsis, _($, field("item", $.base_type)))),
    type_body: ($) => layoutType($),
    ellipsis: ($) => "...",
    rest_op: ($) => "..",

    constraint_clause: ($) =>
      seq(
        _($, $.kw_where),
        choice(
          $.constraint_entry,
          flexCollection(
            $,
            $.lparen,
            $.rparen,
            $.constraint_entry,
            _($, $.comma),
          ),
        ),
      ),
    constraint_entry: ($) =>
      seq(
        field("type_var", $.identifier),
        _($, $.colon),
        field("constraint", $.constraint_sum),
      ),
    constraint_sum: ($) =>
      prec.left(
        seq(
          field("shape", $.path),
          many(seq(_($, $.plus_op), field("shape", $.path))),
        ),
      ),
    function_type: ($) =>
      seq(
        _($, $.kw_fn),
        collection(
          $,
          $.lparen,
          $.rparen,
          field("param", $.type_expression),
          _($, $.comma),
        ),
        opt(seq(_($, $.arrow), field("result", $.type_expression))),
      ),
    applied_type: ($) =>
      seq(field("constructor", $.path), field("args", $.type_argument_list)),
    self_type: ($) => $.kw_Self,
    type_argument_list: ($) =>
      collection($, $.lbracket, $.rbracket, $.type_expression, _($, $.comma)),
    unit_type: ($) => seq($.lparen, many($.newline), $.rparen),
    record_type_field: ($) =>
      seq(
        attributePrefix($),
        field("name", $.field_name),
        _($, $.colon),
        field("type_ann", $.type_body),
      ),
    record_type: ($) =>
      flexCollection($, $.lbrace, $.rbrace, $.record_type_field, semiSep($)),
    tuple_type: ($) =>
      tuple($, $.lparen_hash, $.rparen, $.type_expression, _($, $.comma)),
    wildcard_type: ($) => $.wildcard,
    parenthesized_type: ($) => seq($.lparen, _($, $.type_expression), $.rparen),

    literal: ($) =>
      choice(
        $.percent_literal,
        $.int_literal,
        $.float_literal,
        $.char_literal,
        $.text,
      ),
    percent_literal: ($) =>
      token(
        choice(
          new RustRegex(`${DEC_DIGITS}\\.${DEC_DIGITS}${EXPONENT}?${PERCENT}`),
          new RustRegex(`${DEC_DIGITS}\\.${EXPONENT}?${PERCENT}`),
          new RustRegex(`\\.${DEC_DIGITS}${EXPONENT}?${PERCENT}`),
          new RustRegex(`${DEC_DIGITS}${EXPONENT}?${PERCENT}`),
        ),
      ),
    float_literal: ($) =>
      token(
        choice(
          new RustRegex(
            `${DEC_DIGITS}\\.${DEC_DIGITS}${EXPONENT}?${FLOAT_SUFFIX}`,
          ),
          new RustRegex(`${DEC_DIGITS}\\.${EXPONENT}?${FLOAT_SUFFIX}`),
          new RustRegex(`\\.${DEC_DIGITS}${EXPONENT}?${FLOAT_SUFFIX}`),
          new RustRegex(`${DEC_DIGITS}${EXPONENT}${FLOAT_SUFFIX}`),
        ),
      ),
    int_literal: ($) =>
      token(
        choice(
          new RustRegex(`0[bB]${BIN_DIGITS}${INT_SUFFIX}`),
          new RustRegex(`0[oO]${OCT_DIGITS}${INT_SUFFIX}`),
          new RustRegex(`0[xX]${HEX_DIGITS}${INT_SUFFIX}`),
          new RustRegex(`${DEC_DIGITS}${INT_SUFFIX}`),
        ),
      ),

    text: ($) =>
      seq(
        $.quote,
        many(choice($.text_content, $.escape_sequence, $.interpolation)),
        $.quote,
      ),
    text_content: ($) => token(new RustRegex('[^"\\\\\\n]+')),
    char_literal: ($) =>
      token(
        choice(
          new RustRegex("'[^'\\\\]'"),
          new RustRegex(`'\\\\${CHAR_ESCAPE}'`),
        ),
      ),
    interpolation: ($) =>
      seq($.interpolation_start, _($, $.expression), $.rparen),
    interpolation_start: ($) => token(new RustRegex("\\\\\\(")),
    escape_sequence: ($) => token(new RustRegex(`\\\\${STRING_ESCAPE}`)),
    static_text: ($) =>
      seq(
        $.quote,
        many(choice($.static_text_content, $.escape_sequence)),
        $.quote,
      ),
    static_text_content: ($) => token(new RustRegex('[^"\\\\\\n]+')),
    line_comment: (_) => token(new RustRegex("//[^\\n]*")),
    block_comment: (_) =>
      token(seq("/>", new RustRegex("([^<]|<[^/])*"), "</")),

    identifier: ($) =>
      token(new RustRegex("[_\\p{ID_Start}][\\p{ID_Continue}]*!?")),
    path_head: ($) => choice($.identifier, $.kw_self),
    path: ($) => seq($.path_head, repeat(seq($.module_sep, $.identifier))),
    placeholder: ($) => token("__"),
    wildcard: ($) => "_",

    ...Object.fromEntries(KEYWORDS.map((k) => [`kw_${k}`, () => k])),

    lparen: () => "(",
    rparen: () => ")",
    lbracket: () => "[",
    rbracket: () => "]",
    lbrace: () => "{",
    rbrace: () => "}",
    lparen_hash: () => token("#("),
    lbracket_map: () => token("#map["),
    quote: () => '"',
    comma: () => ",",
    colon: () => ":",
    equals: () => "=",
    semicolon: () => ";",
    dot: () => token.immediate("."),
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
    arrow: () => "->",
    left_arrow: () => "<-",
    fat_arrow: () => "=>",
    try_op: () => "?",
    newline: () => token(new RustRegex("\\r?\\n")),
  },
});
