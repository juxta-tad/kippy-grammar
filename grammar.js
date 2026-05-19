// =============================================================================
// Kippy tree-sitter grammar — Sketch B
// =============================================================================
// Surface syntax rules:
//   - Every top-level declaration is `[pub] name [generics] [: Type] [= value]`.
//     The kind of declaration is determined by what's on the right side.
//   - Type-namespace declarations use a constructor keyword after `:`:
//        record, choice, shape, distinct, alias, tag.
//   - Value-namespace declarations have any other type, and may have `=`:
//        name : fn(Int) -> Text          // forward declaration
//        name = fn(x) => ...             // definition with inferred type
//        name : fn(Int) -> Text = ...    // both
//   - Commas separate items in a value or type.
//   - Semicolons separate items in a block.
//   - Function-shaped things use parenthesized parameter lists.
//   - `=>` is "function-like body follows". `->` is the function return arrow.
// =============================================================================


// -----------------------------------------------------------------------------
// Precedence levels
// -----------------------------------------------------------------------------
const PREC = {
  MATCH:   1,
  PIPE:    2,
  OR:      3,
  AND:     4,
  COMPARE: 5,
  ADD:     6,
  MUL:     7,
  UNARY:   8,
  POSTFIX: 9,
};


// -----------------------------------------------------------------------------
// Reserved keywords
// -----------------------------------------------------------------------------
// Removed from prior grammar: `sig`. Its role (forward declaration of a
// value with a type but no body) is now taken by the bare `name : Type`
// form of `binding`.
//
// `let` is kept, but its top-level role is gone — it now serves *only*
// as the introducer for `let ... in ...` expressions. At the top level,
// what used to be `let name = value` is now bare `name = value`.
const KEYWORDS = [
  "pub", "let", "rec",
  "alias", "distinct", "tag", "record", "choice", "shape", "intrinsic",
  "expect",
  "if", "then", "else", "to", "in", "where",
  "module", "use", "build",
  "type", "fit", "derive", "fn", "test",
  "or", "and", "not", "mod", "as",
  "self", "Self",
];


// -----------------------------------------------------------------------------
// Lexical building blocks
// -----------------------------------------------------------------------------
const DEC_DIGITS  = "(?:[0-9]|[0-9][0-9_]*[0-9])";
const HEX_DIGITS  = "(?:[0-9a-fA-F]|[0-9a-fA-F][0-9a-fA-F_]*[0-9a-fA-F])";
const OCT_DIGITS  = "(?:[0-7]|[0-7][0-7_]*[0-7])";
const BIN_DIGITS  = "(?:[01]|[01][01_]*[01])";
const INT_SUFFIX  = "(?:U8|U16|U32|U64|I8|I16|I32|I64)?";
const FLOAT_SUFFIX = "(?:F32|F64)?";
const PERCENT      = "%";
const EXPONENT     = "(?:[eE][+-]?(?:[0-9]|[0-9][0-9_]*[0-9]))";
const ESCAPE_BODY  =
  `(?:[ntrbfv0'"\\\\]|x[0-9A-Fa-f]{2}|u\\([0-9A-Fa-f]{1,8}\\)|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})`;


// =============================================================================
// Generic helpers
// =============================================================================
const opt   = optional;
const many  = repeat;
const many1 = repeat1;

function sep1(rule, separator) {
  return seq(rule, many(seq(separator, rule)));
}

function separated1($, rule, separator, { optional_separator = false } = {}) {
  if (optional_separator) {
    return seq(rule, many(seq(opt(separator), rule)), opt(separator));
  }
  return seq(rule, many(seq(separator, rule)), opt(separator));
}

function delimited($, open, close, interior) {
  return seq(open, opt(interior), close);
}

function looseSeparated2Plus($, rule, separator) {
  return seq(rule, separator, rule, many(seq(separator, rule)), opt(separator));
}

function collection($, open, close, item, separator, opts = {}) {
  return delimited($, open, close, separated1($, item, separator, opts));
}

function flexCollection($, open, close, rule, separator, { optional_separator = false } = {}) {
  const body = seq(
    rule,
    many(seq(optional_separator ? opt(separator) : separator, rule)),
    opt(separator),
  );
  return seq(open, opt(body), close);
}

function fileBody($, header, item) {
  return seq(opt(header), repeat(item));
}

function separatedWithOptionalRest(item, separator, rest) {
  return opt(
    choice(seq(sep1(item, separator), opt(seq(separator, rest))), rest),
  );
}

function fieldPattern(fieldName, colon, valueRule) {
  return choice(seq(fieldName, colon, valueRule), fieldName);
}

function parameterList($, paramRule) {
  return seq(
    field("param", paramRule),
    many(seq($.comma, field("param", paramRule))),
    opt($.comma),
  );
}

function leftAssocBinop(precedence, operandRule, opRule, { single = false } = {}) {
  if (single) {
    return prec.left(precedence, seq(
      field("lhs", operandRule),
      opt(seq(field("op", opRule), field("rhs", operandRule))),
    ));
  }
  return prec.left(precedence, seq(
    field("lhs", operandRule),
    many(seq(field("op", opRule), field("rhs", operandRule))),
  ));
}


// =============================================================================
// Kippy-specific helpers
// =============================================================================
function bracedCollection($, rule, separator) {
  return flexCollection($, $.lbrace, $.rbrace, rule, separator);
}
function bracedSemiBlock($, rule) {
  return bracedCollection($, rule, $.semicolon);
}

function parenParamList($) {
  return seq($.lparen, opt(parameterList($, $.binding_pattern)), $.rparen);
}

function parenPayloadList($, payloadRule) {
  return seq(
    $.lparen,
    separated1($, field("payload", payloadRule), $.comma),
    $.rparen,
  );
}

function tuple($, item, separator) {
  return delimited(
    $,
    $.lparen_hash,
    $.rparen,
    looseSeparated2Plus($, field("element", item), separator),
  );
}

function bracketedWithRest($, open, close, item, separator, rest) {
  return seq(open, separatedWithOptionalRest(item, separator, rest), close);
}

function withAttributes($, ...rest) {
  return seq(many(field("attribute", $.attribute)), ...rest);
}

function optTypeParams($) {
  return opt(field("type_params", $.type_parameter_list));
}


// =============================================================================
// Grammar
// =============================================================================
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

  supertypes: ($) => [$.expression],

  inline: ($) => [
    $.value_slot,
    $.match_arm_value,
    $.method_body,
    $.lambda_body,
    $.let_body,
    $.if_then_value,
    $.if_else_value,
    $._declaration_inner,
    $._top_level_item,
    $._type_constructor,
  ],

  rules: {

    // -------------------------------------------------------------------------
    // 1. Source structure
    // -------------------------------------------------------------------------
    source_file: ($) => fileBody($, $.module_declaration, $.module_item),

    module_declaration: ($) => seq($.kw_module, field("name", $.path)),

    module_item: ($) => withAttributes($, $._top_level_item),
    _top_level_item: ($) => choice($.use_statement, $.declaration),

    use_statement: ($) =>
      seq(
        $.kw_use,
        field("module", $.path),
        opt(seq($.kw_as, field("alias", $.identifier))),
        opt(seq($.dot, field("imports", $.import_set))),
      ),
    import_set: ($) =>
      seq($.lbrace, opt(separated1($, $.import_item, $.comma)), $.rbrace),
    import_item: ($) =>
      seq(
        field("name", $.identifier),
        opt(seq($.kw_as, field("alias", $.identifier))),
      ),

    // -------------------------------------------------------------------------
    // 2. Declarations
    // -------------------------------------------------------------------------
    // All declarations share the unified shape:
    //   [pub] name [generics] [: Type-or-Constructor] [= value]
    //
    // Test, fit, derive, and implementation are still keyword-led because
    // they're actions, not "this is a named thing" declarations.
    declaration: ($) =>
      seq(field("visibility", opt($.kw_pub)), $._declaration_inner),

    _declaration_inner: ($) =>
      choice(
        $.binding,
        $.derive_declaration,
        $.test_declaration,
        $.implementation,
      ),

    // The unified binding form. Either the right side starts with a type
    // constructor (`record`/`choice`/`shape`/`distinct`/`alias`/`tag`),
    // in which case this is a type-namespace declaration, or it's any
    // other type and possibly a value, in which case it's a value-namespace
    // declaration. Both are produced by the same rule; tooling can branch
    // at the AST level on which constructor (if any) appears.
    binding: ($) =>
      seq(
        opt($.kw_rec),
        field("name", $.binding_name),
        optTypeParams($),
        choice(
          // `Name : type-or-constructor [= value]`
          seq(
            $.colon,
            field("annotation", $.binding_annotation),
            opt(seq($.equals, $.value_slot)),
          ),
          // `name = value`  (no type ascription)
          seq($.equals, $.value_slot),
        ),
        opt(field("constraints", $.constraint_clause)),
      ),

    // Right-hand side of `:`. Either a type-constructor form (which makes
    // this a type-namespace declaration) or a plain type expression (which
    // makes it a value-namespace declaration).
    binding_annotation: ($) =>
      choice(
        $._type_constructor,
        field("type", $.type_expression),
      ),

    _type_constructor: ($) =>
      choice(
        $.alias_constructor,
        $.distinct_constructor,
        $.tag_constructor,
        $.intrinsic_constructor,
        $.record_constructor,
        $.choice_constructor,
        $.shape_constructor,
      ),

    // -------------------------------------------------------------------------
    // 3. Type constructors (appear after `:` in a binding)
    // -------------------------------------------------------------------------
    alias_constructor: ($) =>
      seq($.kw_alias, field("body", $.type_expression)),

    // `distinct` always wraps a base type — `UserId : distinct Int`. For
    // a marker with no payload, use `tag` instead.
    distinct_constructor: ($) =>
      seq($.kw_distinct, field("body", $.type_expression)),

    // `tag` is a marker with no body (atoms / phantom types / unit-like
    // distinct names).
    tag_constructor: ($) => $.kw_tag,

    // `intrinsic` is a type whose representation is supplied by the
    // compiler rather than declared in Kippy source. Paired with a
    // `#lang("...")` attribute that binds the name to a compiler-known
    // layout. Used for primitives (I8, F64, Text, List) where there
    // is no Kippy-level base type to wrap.
    intrinsic_constructor: ($) => $.kw_intrinsic,

    record_constructor: ($) =>
      seq($.kw_record, field("body", $.record_type)),

    choice_constructor: ($) =>
      seq($.kw_choice, field("body", bracedSemiBlock($, $.choice_variant))),

    shape_constructor: ($) =>
      seq(
        $.kw_shape,
        opt(field("parents", $.shape_parents)),
        field("members", bracedSemiBlock($, $.shape_member)),
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
      collection($, $.lbracket, $.rbracket, $.identifier, $.comma),

    // -------------------------------------------------------------------------
    // 4. Shapes and fits
    // -------------------------------------------------------------------------
    // Shape members keep the same `name : Type [= default]` form as
    // top-level value declarations. The shape body is a block of these.
    shape_parents: ($) =>
      seq($.colon, sep1(field("parent", $.path_or_applied), $.comma)),
    shape_member: ($) => choice($.shape_type_decl, $.shape_method),
    shape_type_decl: ($) =>
      withAttributes($, $.kw_type, field("name", $.type_member_name)),
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

    implementation: ($) =>
      seq(
        $.kw_fit,
        optTypeParams($),
        field("type", $.impl_type_head),
        $.colon,
        field("shape", $.path),
        opt(field("constraints", $.constraint_clause)),
        field("members", bracedSemiBlock($, $.fit_member)),
      ),
    derive_declaration: ($) =>
      seq(
        $.kw_derive,
        optTypeParams($),
        field("type", $.impl_type_head),
        $.colon,
        field("shape", $.path),
        opt(field("constraints", $.constraint_clause)),
      ),
    impl_type_head: ($) => $._concrete_type_head,
    fit_member: ($) => choice($.fit_type_def, $.fit_method),
    fit_type_def: ($) =>
      withAttributes(
        $,
        $.kw_type,
        field("name", $.type_member_name),
        $.equals,
        field("value", $.type_expression),
      ),
    fit_method: ($) =>
      withAttributes(
        $,
        field("name", $.identifier),
        field("parameters", $.method_parameter_list),
        $.fat_arrow,
        $.method_body,
      ),
    method_parameter_list: ($) => parenParamList($),

    // -------------------------------------------------------------------------
    // 5. Attributes
    // -------------------------------------------------------------------------
    attribute: ($) =>
      seq(
        $.hash_sign,
        field("path", $.path),
        opt(field("args", $.attribute_arguments_inline)),
      ),
    attribute_arguments_inline: ($) =>
      collection($, $.lparen, $.rparen, $.attribute_argument, $.comma),
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
      collection($, $.lbracket, $.rbracket, $.attribute_value, $.comma),
    attribute_record_value: ($) =>
      bracedCollection($, $.attribute_record_field, $.comma),
    attribute_record_field: ($) =>
      seq(
        field("name", $.field_name),
        $.equals,
        field("value", $.attribute_value),
      ),

    // -------------------------------------------------------------------------
    // 6. Tests
    // -------------------------------------------------------------------------
    test_declaration: ($) =>
      seq(
        $.kw_test,
        field("name", $.static_text),
        field("body", bracedSemiBlock($, $.test_statement)),
      ),
    test_statement: ($) =>
      choice($.test_binding, $.expect_statement),
    // Test bindings reuse the top-level binding form.
    test_binding: ($) => $.binding,
    expect_statement: ($) => seq($.kw_expect, field("value", $.expression)),

    // -------------------------------------------------------------------------
    // 7. Names
    // -------------------------------------------------------------------------
    binding_name:     ($) => reserved("global", $.identifier),
    type_member_name: ($) => reserved("global", $.identifier),
    field_name:       ($) => reserved("global", $.identifier),

    // -------------------------------------------------------------------------
    // 8. Expressions — top-level dispatch
    // -------------------------------------------------------------------------
    expression: ($) =>
      choice(
        $.lambda_expression,
        $.if_expression,
        $.let_expression,
        $.pipe_expression,
      ),

    value_slot:      ($) => field("value",      $.expression),
    if_then_value:   ($) => field("then_value", $.expression),
    if_else_value:   ($) => field("else_value", $.expression),
    let_body:        ($) => field("body",       $.expression),
    lambda_body:     ($) => field("body",       $.expression),
    method_body:     ($) => field("body",       $.expression),
    match_arm_value: ($) => field("value",      $.expression),

    spread_element: ($) => seq($.rest_op, field("base", $.expression)),

    // -------------------------------------------------------------------------
    // 9. Expression operator ladder
    // -------------------------------------------------------------------------
    pipe_expression:    ($) => leftAssocBinop(PREC.PIPE, $.or_expression,      $.pipe),
    or_expression:      ($) => leftAssocBinop(PREC.OR,   $.and_expression,     $.or_op),
    and_expression:     ($) => leftAssocBinop(PREC.AND,  $.compare_expression, $.and_op),
    compare_expression: ($) => leftAssocBinop(
      PREC.COMPARE,
      $.add_expression,
      choice($.le_op, $.ge_op, $.eq_op, $.ne_op, $.lt_op, $.gt_op),
      { single: true },
    ),
    add_expression: ($) => leftAssocBinop(PREC.ADD, $.mul_expression,   choice($.plus_op, $.minus_op)),
    mul_expression: ($) => leftAssocBinop(PREC.MUL, $.unary_expression, choice($.star_op, $.slash_op, $.kw_mod)),

    unary_expression: ($) =>
      choice(
        prec.right(PREC.UNARY, seq(
          field("op", choice($.minus_op, $.kw_not)),
          field("operand", $.unary_expression),
        )),
        $.match_expression,
      ),

    match_expression: ($) =>
      prec(PREC.MATCH, choice(
        seq(
          field("subject", $.postfix_expression),
          $.kw_to,
          field("body", bracedSemiBlock($, $.match_arm)),
        ),
        $.postfix_expression,
      )),

    // -------------------------------------------------------------------------
    // 10. Postfix chain
    // -------------------------------------------------------------------------
    postfix_expression: ($) =>
      prec.left(PREC.POSTFIX, seq(
        field("base", $.primary_expression),
        many(choice(
          $.record_suffix,
          $.call_suffix,
          $.index_suffix,
          $.field_suffix,
          $.try_op,
          $.method_suffix,
        )),
      )),

    call_suffix: ($) =>
      seq(
        $.lparen,
        opt(separated1($, field("arg", $.call_argument), $.comma)),
        $.rparen,
      ),
    call_argument: ($) => $.expression,
    index_suffix:  ($) => seq($.lbracket, field("index", $.expression), $.rbracket),
    field_suffix:  ($) => seq($.dot, field("field", $.field_name)),
    method_suffix: ($) =>
      seq(
        $.at_sign,
        field("method", $.identifier),
        opt(seq($.colon, field("shape", $.path))),
      ),
    record_suffix: ($) => field("body", $.record_body),

    // -------------------------------------------------------------------------
    // 11. Primary expressions
    // -------------------------------------------------------------------------
    primary_expression: ($) =>
      choice(
        $.record_builder,
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
      collection($, $.lbracket, $.rbracket, $.list_item, $.comma),
    list_item: ($) => choice($.expression, $.spread_element),
    map_expression: ($) =>
      collection($, $.lbracket_map, $.rbracket, $.map_entry, $.comma),
    map_entry: ($) =>
      seq(field("key", $.expression), $.fat_arrow, $.value_slot),

    tuple_expression: ($) => tuple($, $.expression, $.comma),
    parenthesized_expression: ($) =>
      seq($.lparen, field("value", $.expression), $.rparen),

    record_builder: ($) =>
      seq($.kw_build, field("builder", $.path), $.builder_body),
    record_body:    ($) => bracedCollection($, $.record_field,  $.comma),
    builder_body:   ($) => bracedCollection($, $.builder_field, $.comma),
    record_field: ($) =>
      choice(
        seq(field("name", $.field_name), $.equals, $.value_slot),
        $.spread_element,
      ),
    builder_field: ($) =>
      seq(field("name", $.field_name), $.left_arrow, $.value_slot),

    // -------------------------------------------------------------------------
    // 12. Control flow
    // -------------------------------------------------------------------------
    // `let-in` is the only place the `let` keyword appears in Sketch B.
    // Top-level value definitions use bare `name = value`; `let` is only
    // for introducing a sequence of bindings inside an expression.
    let_expression: ($) =>
      prec.right(seq(
        $.kw_let,
        separated1($, $.local_binding, $.semicolon, { optional_separator: true }),
        $.kw_in,
        $.let_body,
      )),

    // A local binding inside `let-in` is the same shape as a top-level
    // value-namespace binding (no type constructors allowed locally).
    local_binding: ($) =>
      seq(
        opt($.kw_rec),
        field("pattern", $.binding_pattern),
        opt(seq($.colon, field("type_ann", $.type_expression))),
        $.equals,
        $.value_slot,
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

    match_arm: ($) =>
      seq(field("pattern", $.pattern), $.fat_arrow, $.match_arm_value),

    lambda_parameters: ($) => parenParamList($),
    lambda_expression: ($) =>
      prec.right(seq($.kw_fn, $.lambda_parameters, $.fat_arrow, $.lambda_body)),

    // -------------------------------------------------------------------------
    // 13. Patterns
    // -------------------------------------------------------------------------
    pattern: ($) =>
      seq($.unguarded_pattern, opt(seq($.kw_if, field("guard", $.expression)))),
    unguarded_pattern: ($) => $.or_pattern,

    or_pattern: ($) => prec.left(sep1($.as_pattern, $.bar)),
    as_pattern: ($) =>
      prec.right(1, choice(
        seq($.atomic_pattern, $.kw_as, field("binding", $.identifier)),
        $.atomic_pattern,
      )),

    atomic_pattern: ($) =>
      choice(
        $.literal,
        $.wildcard_pattern,
        $.path_pattern,
        $.list_pattern,
        $.tuple_pattern,
        $.record_pattern,
        seq($.lparen, $.pattern, $.rparen),
      ),

    path_pattern: ($) =>
      seq(
        field("constructor", $.path),
        opt(parenPayloadList($, $.tag_payload_pattern)),
      ),
    tag_payload_pattern: ($) =>
      choice(
        $.literal,
        $.wildcard_pattern,
        $.path_pattern,
        $.list_pattern,
        $.tuple_pattern,
        $.record_pattern,
        seq($.lparen, $.pattern, $.rparen),
      ),

    wildcard_pattern: ($) => $.wildcard,
    unit_pattern:     ($) => seq($.lparen, $.rparen),

    list_pattern: ($) =>
      bracketedWithRest($, $.lbracket, $.rbracket, $.pattern, $.comma, $.rest_pattern),
    tuple_pattern: ($) => tuple($, $.pattern, $.comma),
    record_pattern: ($) =>
      bracketedWithRest($, $.lbrace, $.rbrace, $.record_pattern_field, $.comma, $.rest_op),
    record_pattern_field: ($) => fieldPattern($.field_name, $.colon, $.pattern),
    rest_pattern: ($) => seq($.rest_op, field("binding", $.identifier)),

    binding_pattern: ($) =>
      choice(
        $.unit_pattern,
        $.wildcard_pattern,
        $.identifier,
        $.binding_list_pattern,
        $.binding_tuple_pattern,
        $.binding_record_pattern,
      ),
    binding_list_pattern: ($) =>
      bracketedWithRest($, $.lbracket, $.rbracket, $.binding_pattern, $.comma, $.rest_pattern),
    binding_tuple_pattern: ($) => tuple($, $.binding_pattern, $.comma),
    binding_record_pattern: ($) =>
      bracketedWithRest($, $.lbrace, $.rbrace, $.binding_record_pattern_field, $.comma, $.rest_op),
    binding_record_pattern_field: ($) =>
      fieldPattern($.field_name, $.colon, $.binding_pattern),

    // -------------------------------------------------------------------------
    // 14. Type expressions
    // -------------------------------------------------------------------------
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
      collection($, $.lbracket, $.rbracket, $.type_expression, $.comma),

    function_type: ($) =>
      seq(
        $.kw_fn,
        collection($, $.lparen, $.rparen, field("param", $.type_expression), $.comma),
        opt(seq($.arrow, field("result", $.type_expression))),
      ),

    record_type: ($) =>
      flexCollection($, $.lbrace, $.rbrace, $.record_type_field, $.comma),
    record_type_field: ($) =>
      withAttributes(
        $,
        field("name", $.field_name),
        $.colon,
        field("type_ann", $.type_expression),
      ),
    tuple_type:         ($) => tuple($, $.type_expression, $.comma),
    self_type:          ($) => $.kw_Self,
    unit_type:          ($) => seq($.lparen, $.rparen),
    wildcard_type:      ($) => $.wildcard,
    parenthesized_type: ($) => seq($.lparen, $.type_expression, $.rparen),

    // -------------------------------------------------------------------------
    // 15. Constraint clauses
    // -------------------------------------------------------------------------
    constraint_clause: ($) =>
      seq(
        $.kw_where,
        choice(
          $.constraint_entry,
          flexCollection($, $.lparen, $.rparen, $.constraint_entry, $.comma),
        ),
      ),
    constraint_entry: ($) =>
      seq(
        field("type_var", $.identifier),
        $.colon,
        field("constraint", $.constraint_sum),
      ),
    constraint_sum: ($) =>
      prec.left(seq(
        field("shape", $.path),
        many(seq($.plus_op, field("shape", $.path))),
      )),

    // -------------------------------------------------------------------------
    // 16. Literals
    // -------------------------------------------------------------------------
    literal: ($) =>
      choice(
        $.percent_literal,
        $.int_literal,
        $.float_literal,
        $.char_literal,
        $.text,
      ),

    percent_literal: ($) =>
      token(choice(
        new RustRegex(`${DEC_DIGITS}\\.${DEC_DIGITS}${EXPONENT}?${PERCENT}`),
        new RustRegex(`${DEC_DIGITS}\\.${EXPONENT}?${PERCENT}`),
        new RustRegex(`\\.${DEC_DIGITS}${EXPONENT}?${PERCENT}`),
        new RustRegex(`${DEC_DIGITS}${EXPONENT}?${PERCENT}`),
      )),
    float_literal: ($) =>
      token(choice(
        new RustRegex(`${DEC_DIGITS}\\.${DEC_DIGITS}${EXPONENT}?${FLOAT_SUFFIX}`),
        new RustRegex(`${DEC_DIGITS}\\.${EXPONENT}?${FLOAT_SUFFIX}`),
        new RustRegex(`\\.${DEC_DIGITS}${EXPONENT}?${FLOAT_SUFFIX}`),
        new RustRegex(`${DEC_DIGITS}${EXPONENT}${FLOAT_SUFFIX}`),
      )),
    int_literal: ($) =>
      token(choice(
        new RustRegex(`0[bB]${BIN_DIGITS}${INT_SUFFIX}`),
        new RustRegex(`0[oO]${OCT_DIGITS}${INT_SUFFIX}`),
        new RustRegex(`0[xX]${HEX_DIGITS}${INT_SUFFIX}`),
        new RustRegex(`${DEC_DIGITS}${INT_SUFFIX}`),
      )),

    char_literal: ($) =>
      token(choice(
        new RustRegex("'[^'\\\\]'"),
        new RustRegex(`'\\\\${ESCAPE_BODY}'`),
      )),

    text: ($) =>
      seq(
        $.quote,
        many(choice($.text_content, $.escape_sequence, $.interpolation)),
        $.quote,
      ),
    text_content:        ($) => token(new RustRegex('[^"\\\\\\r\\n]+')),
    static_text:         ($) =>
      seq($.quote, many(choice($.static_text_content, $.escape_sequence)), $.quote),
    static_text_content: ($) => token(new RustRegex('[^"\\\\\\r\\n]+')),
    interpolation:       ($) => seq($.interpolation_start, $.expression, $.rparen),
    interpolation_start: ($) => token(new RustRegex("\\\\\\(")),
    escape_sequence:     ($) => token(new RustRegex(`\\\\${ESCAPE_BODY}`)),

    // -------------------------------------------------------------------------
    // 17. Comments
    // -------------------------------------------------------------------------
    line_comment:  (_) => token(new RustRegex("//[^\\n]*")),
    block_comment: (_) => token(seq("/>", /([^<]|<[^/])*/, "</")),

    // -------------------------------------------------------------------------
    // 18. Identifiers, paths, special operators
    // -------------------------------------------------------------------------
    identifier: ($) =>
      token(new RustRegex("[_\\p{ID_Start}][\\p{ID_Continue}]*!?")),
    path_head: ($) => choice($.identifier, $.kw_self),
    path:      ($) => seq($.path_head, repeat(seq($.module_sep, $.identifier))),
    placeholder: ($) => token("__"),
    wildcard:    ($) => "_",
    ellipsis:    ($) => "...",
    rest_op:     ($) => "..",

    // -------------------------------------------------------------------------
    // 19. Keyword tokens
    // -------------------------------------------------------------------------
    ...Object.fromEntries(KEYWORDS.map((k) => [`kw_${k}`, () => k])),

    // -------------------------------------------------------------------------
    // 20. Punctuation and operator tokens
    // -------------------------------------------------------------------------
    lparen:       () => "(",
    rparen:       () => ")",
    lbracket:     () => "[",
    rbracket:     () => "]",
    lbrace:       () => "{",
    rbrace:       () => "}",
    lparen_hash:  () => token("#("),
    lbracket_map: () => token("#["),
    quote:        () => '"',
    comma:        () => ",",
    colon:        () => ":",
    equals:       () => "=",
    semicolon:    () => ";",
    dot:          () => token.immediate("."),
    module_sep:   () => token.immediate("::"),
    at_sign:      () => token.immediate("@"),
    hash_sign:    () => "#",

    pipe:      () => token("|>"),
    bar:       () => token("|"),
    or_op:     ($) => $.kw_or,
    and_op:    ($) => $.kw_and,
    plus_op:   () => "+",
    minus_op:  () => "-",
    star_op:   () => "*",
    slash_op:  () => "/",
    eq_op:     () => "==",
    ne_op:     () => "!=",
    le_op:     () => "<=",
    ge_op:     () => ">=",
    lt_op:     () => "<",
    gt_op:     () => ">",

    arrow:      () => "->",
    left_arrow: () => "<-",
    fat_arrow:  () => "=>",
    try_op:     () => "?",
  },
});
