const PREC = {
  // Lowest to highest precedence
  PIPE: 1,
  OR: 2,
  AND: 3,
  COMPARE: 4,
  ADD: 5,
  MUL: 6,
  UNARY: 7,
  POSTFIX: 8,  // unified postfix chain (calls, fields, try operator)
};

module.exports = grammar({
  name: "kippy",

  // tree-sitter uses this for keyword extraction and error recovery.
  word: $ => $.identifier,

  // layout-sensitive tokens are provided externally by the scanner.
  externals: $ => [
    $.newline,
    $.indent,
    $.dedent,
  ],

  // whitespace and comments are ignored everywhere unless explicitly required.
  extras: $ => [
    /[ \t\r\f]+/,
    $.doc_comment,
    $.line_comment,
    $.block_comment,
  ],

  // supertypes enable robust syntax highlighting, folding, navigation, and queries.
  // Note: Tree-Sitter supertypes must be pure wrappers (single symbol, no choice/seq/repeat).
  // Only expression and postfix_expression qualify in this grammar.
  // Primary expression classes (primary_expression, pattern, atomic_pattern, type_expression)
  // have internal choice/seq structure, so they cannot be supertypes.
  supertypes: $ => [
    $.expression,
    $.postfix_expression,
  ],

  inline: $ => [
    $.field_name,
  ],

  rules: {
    //
    // A source file is a newline-separated list of module items.
    // Leading blank lines are allowed. Multiple items cannot share one line.
    source_file: $ => seq(
      repeat($.newline),
      repeat(seq(
        $.module_item,
        repeat($.newline),
      )),
    ),

    // top-level declarations supported by the module.
    module_item: $ => choice(
      $.use_statement,
      $.module_declaration,
      $.type_declaration,
      $.let_binding,
      $.signature,
      $.expect_statement,
      $.implementation,
      $.ability_declaration,
    ),

    // import/reference another module path.
    use_statement: $ => seq(
      $.kw_use,
      $.long_identifier,
    ),

    //
    // Nested module declaration with an indented body.
    // Example:
    //   module Foo
    //     let x = 1
    module_declaration: $ => seq(
      $.kw_module,
      field("name", $.type_name),
      $.newline,
      $.indent,
      field("items", seq(
        repeat(seq($.module_item, repeat($.newline))),
      )),
      $.dedent,
    ),

    //
    // Type alias / type declaration.
    // Parameters are bare identifiers after the type name.
    type_declaration: $ => seq(
      $.kw_type,
      field("name", $.type_name),
      repeat(field("param", $.identifier)),
      $.equals,
      field("value", $.type_expression),
    ),

    //
    // Standalone annotation node used by ability method declarations.
    // Supports leading attributes and same-line or indented type bodies.
    annotation: $ => seq(
      repeat(seq($.attribute, optional($.newline))),
      field("name", $.binding_target),
      $.colon,
      field("type", inline_or_block($, $.type_expression)),
      optional(field("constraints", $.constraint_clause)),
    ),

    // top-level signature declaration.
    signature: $ => seq(
      $.kw_sig,
      field("name", $.identifier),
      $.colon,
      field("type", inline_or_block($, $.type_expression)),
      optional(field("constraints", $.constraint_clause)),
    ),

    //
    // Value definitions support:
    //   let name : Type
    //   let name = expr
    //   let name : Type = expr
    // Also supports attributes, pub, and cert modifiers.
    let_binding: $ => seq(
      repeat(seq($.attribute, optional($.newline))),
      optional($.kw_pub),
      $.kw_let,
      optional($.kw_cert),
      field("name", $.binding_target),
      choice(
        seq(
          $.colon,
          field("type", inline_or_block($, $.type_expression)),
          optional(field("constraints", $.constraint_clause)),
        ),
        seq(
          optional(seq(
            $.colon,
            field("type", inline_or_block($, $.type_expression)),
          )),
          $.equals,
          field("value", inline_or_block($, $.expression)),
        ),
      ),
    ),

    // Attributes are simple name references without arguments.
    // Examples:
    //   @deprecated
    //   @inline
    //   @optimize.inline
    attribute: $ => seq(
      "@",
      $.long_identifier,
    ),

    // implement an ability for a concrete type.
    implementation: $ => seq(
      $.kw_implement,
      field("ability", $.type_name),
      $.kw_for,
      field("type", $.type_name),
    ),

    //
    // Ability declaration with indented method annotations.
    // Example:
    //   ability Writer
    //     write: File -> Bytes -> Void
    //   ability Reader
    //     read: File -> Bytes
    ability_declaration: $ => seq(
      repeat(seq($.attribute, optional($.newline))),
      $.kw_ability,
      field("name", $.type_name),
      $.newline,
      $.indent,
      field("methods", seq(
        $.annotation,
        repeat(seq(repeat($.newline), $.annotation)),
      )),
      repeat($.newline),
      $.dedent,
    ),

    // assertion/expectation form.
    expect_statement: $ => seq($.kw_expect, field("value", $.expression)),

    //
    // Assignment LHS is limited to lowercase-style identifiers and dotted paths.
    // This avoids ambiguity with constructor/type names.
    binding_target: $ => prec(1, seq(
      $.identifier,
      repeat(seq(token.immediate("."), $.identifier)),
    )),

    // expression entry point.
    expression: $ => $.pipe_expression,

    // pipeline is lowest-precedence expression form.
    pipe_expression: $ => prec.right(PREC.PIPE, seq(
      $.or_expression,
      repeat(seq($.pipe, $.or_expression)),
    )),

    // logical OR chains left-associatively.
    or_expression: $ => prec.left(PREC.OR, seq(
      $.and_expression,
      repeat(seq($.or_op, $.and_expression)),
    )),

    // logical AND chains left-associatively.
    and_expression: $ => prec.left(PREC.AND, seq(
      $.compare_expression,
      repeat(seq($.and_op, $.compare_expression)),
    )),

    //
    // Comparison allows at most one comparator per node.
    // Chained comparisons like a < b < c are not parsed as a single expression here.
    compare_expression: $ => prec.left(PREC.COMPARE, seq(
      $.add_expression,
      optional(seq(choice($.le_op, $.ge_op, $.eq_op, $.ne_op, $.lt_op, $.gt_op), $.add_expression)),
    )),

    // additive operators.
    add_expression: $ => prec.left(PREC.ADD, seq(
      $.mul_expression,
      repeat(seq(choice($.plus, $.minus), $.mul_expression)),
    )),

    // multiplicative operators.
    mul_expression: $ => prec.left(PREC.MUL, seq(
      $.unary_expression,
      repeat(seq(choice($.star, $.slash, $.double_slash, $.percent), $.unary_expression)),
    )),

    // unary negation and logical not bind tighter than binary operators.
    unary_expression: $ => choice(
      prec.right(PREC.UNARY, seq(choice($.minus, $.not_kw), $.unary_expression)),
      $.postfix_expression,
    ),

    //
    // Unified postfix chain:
    //   f()
    //   value.field
    //   value?
    //   get?().x?(y)
    // All postfix forms (calls, fields, try) are handled in a single rule with left associativity.
    postfix_chain: $ => prec.left(PREC.POSTFIX, seq(
      $.primary_expression,
      repeat(choice($.call_suffix, $.projection_suffix, $.try_op)),
    )),

    // alias for postfix_chain kept as the expression-level postfix rule.
    postfix_expression: $ => $.postfix_chain,

    // function call suffix using 'with' keyword.
    // Syntax: func with x, y  (arguments are postfix_chains)
    call_suffix: $ => prec(2, with_call_suffix($)),

    // field projection or tuple/index access via dot syntax (allows keywords).
    projection_suffix: $ => seq(
      $.dot,
      field("field", choice($.field_name, $.tuple_index)),
    ),

    // numeric dot-field like .0, .1.
    tuple_index: $ => token(/[0-9]+/),

    // primary expressions are the irreducible expression forms.
    primary_expression: $ => choice(
      $.when_expression,
      $.if_expression,
      $.lambda_expression,
      $.record_builder,
      $.literal,
      $.long_identifier,
      $.placeholder,
      $.list_expression,
      $.record_expression,
      $.tuple_expression,
      $.parenthesized_expression,
      $.block_expression,
    ),

    // list literal with single-line or layout-sensitive multiline support.
    list_expression: $ => layoutBracket($, $.lbracket, $.rbracket, $.expression),

    //
    // Record literal:
    //   { a: 1, b: 2 }
    //   { a: 1, ..base }
    //   { ..base }
    record_expression: $ => choice(
      singleLineRecordExpression($, $.record_field),
      multiLineRecordExpression($, $.record_field),
    ),

    //
    // Record builder for applicative composition patterns.
    // Example:
    //   build decoder { x: dx, y: dy }
    record_builder: $ => seq(
      $.kw_build,
      field("builder", $.long_identifier),
      layoutBracket($, $.lbrace, $.rbrace, $.record_field),
    ),


    // field name - allows identifiers and contextual keywords.
    field_name: $ => choice(
      $.identifier,
      $.kw_pub, $.kw_let, $.kw_cert, $.kw_expect,
      $.kw_if, $.kw_then, $.kw_else, $.kw_when, $.kw_is,
      $.kw_in, $.kw_where, $.kw_with, $.kw_ability, $.kw_implement,
      $.kw_module, $.kw_use, $.kw_build, $.kw_for, $.kw_type, $.kw_sig, $.kw_fn,
      $.kw_or, $.kw_and, $.kw_not, $.kw_as,
    ),

    // standardised field naming for downstream tooling.
    record_field: $ => seq(
      field("name", $.field_name),
      $.colon,
      field("value", inline_or_block($, $.expression))
    ),

    // tuple literal parser shared with type tuples.
    tuple_expression: $ => tuple_like($, $.expression),

    // grouping expression, not tuple.
    parenthesized_expression: $ => seq(
      $.lparen,
      field("value", $.expression),
      $.rparen,
    ),

    //
    // Block expression:
    // (
    //   let x = 1
    //   in x + 1
    // )
    // or value-only:
    // (
    //   expr
    // )
    block_expression: $ => seq(
      $.lparen,
      repeat1($.newline),
      $.indent,
      choice(
        field("value", withLeadingNewlines($, $.expression)),
        seq(
          repeat(seq($.let_binding, repeat($.newline))),
          $.kw_in,
          field("value", withLeadingNewlines($, $.expression)),
        ),
      ),
      repeat($.newline),
      $.dedent,
      $.rparen,
    ),

    //
    // Pattern matching expression with an indented arm list.
    when_expression: $ => seq(
      $.kw_when,
      field("subject", $.expression),
      $.kw_is,
      $.newline,
      $.indent,
      field("arms", seq(
        repeat(seq($.when_arm, $.newline)),
        $.when_arm,
      )),
      repeat($.newline),
      $.dedent,
    ),

    // full pattern plus optional guard.
    pattern: $ => seq(
      $.or_pattern,
      optional(seq($.kw_if, field("guard", $.expression)))
    ),

    // alternation patterns.
    or_pattern: $ => prec.left(seq(
      $.as_pattern,
      repeat(seq($.pipe_bar, $.as_pattern))
    )),

    // binding the matched value after a successful subpattern match.
    as_pattern: $ => choice(
      seq($.atomic_pattern, $.kw_as, field("binding", $.identifier)),
      $.atomic_pattern
    ),

    // atomic patterns are the non-extendable pattern forms.
    atomic_pattern: $ => choice(
      $.literal,
      $.wildcard_pattern,
      $.identifier,
      $.tag_pattern,
      $.list_pattern,
      $.tuple_pattern,
      $.record_pattern,
      seq($.lparen, $.pattern, $.rparen)
    ),

    // wildcard pattern.
    wildcard_pattern: $ => "_",

    //
    // Non-parenthesised patterns allowed as bare tag arguments.
    // Deliberately excludes tuple/parenthesised forms to avoid Tag(x) ambiguity.
    non_paren_atomic_pattern: $ => choice(
      $.literal,
      $.wildcard_pattern,
      $.identifier,
      $.tag_pattern,
      $.list_pattern,
      $.record_pattern,
    ),

    //
    // Constructor/tag patterns:
    //   Tag
    //   Tag(x, y)
    //   Tag x
    tag_pattern: $ => seq(
      $.tag_name,
      optional(choice(
        seq(
          $.lparen,
          commaSep1Trail($, $.pattern, $.comma, $.newline),
          $.rparen
        ),
        $.non_paren_atomic_pattern
      ))
    ),

    //
    // List patterns:
    //   []
    //   [x, y]
    //   [x, ..rest]
    //   [..rest]
    list_pattern: $ => seq(
      $.lbracket,
      optional(choice(
        seq(
          $.pattern,
          repeat(seq($.comma, $.pattern)),
          optional(seq($.comma, $.rest_pattern))
        ),
        $.rest_pattern
      )),
      $.rbracket
    ),

    // list tail binding.
    rest_pattern: $ => seq(
      "..",
      field("binding", $.identifier)
    ),

    //
    // Tuple pattern must contain a comma so it cannot be confused with grouping.
    // Syntax: #{x, y} not (x, y)
    tuple_pattern: $ => seq(
      $.lbrace_hash,
      $.pattern,
      $.comma,
      commaSepTrail($, $.pattern, $.comma, $.newline),
      $.rbrace
    ),

    //
    // Record patterns:
    //   { age }
    //   { age: x }
    //   { age, .. }
    //   { .. }
    record_pattern: $ => seq(
      $.lbrace,
      optional(choice(
        seq(
          $.record_pattern_field,
          repeat(seq($.comma, $.record_pattern_field)),
          optional(seq($.comma, ".."))
        ),
        ".."
      )),
      $.rbrace
    ),

    // shorthand field or explicit field pattern (allows keywords).
    record_pattern_field: $ => choice(
      seq($.field_name, $.colon, $.pattern),
      $.field_name
    ),

    // one match arm and its result expression.
    when_arm: $ => seq(
      field("pattern", $.pattern),
      $.arrow_op,
      field("value", inline_or_block($, $.expression)),
    ),

    //
    // Lambda syntax:
    //   fn x:
    //   fn x, y, z:
    // Body may be same-line or indented.
    lambda_expression: $ => seq(
      $.kw_fn,
      field("param", $.identifier),
      repeat(seq(
        optional(repeat($.newline)),
        $.comma,
        optional(repeat($.newline)),
        field("param", $.identifier)
      )),
      $.colon,
      field("body", inline_or_block($, $.expression)),
    ),

    // expression-level if/then/else.
    if_expression: $ => seq(
      $.kw_if,
      field("condition", $.expression),
      $.kw_then,
      field("then_value", $.expression),
      $.kw_else,
      field("else_value", $.expression),
    ),

    //
    // Function types are right-associative.
    // Supports:
    //   a -> b
    //   a, b -> c
    //   a -> b -> c
    type_expression: $ => prec.right(choice(
      seq($.function_type_domain, $.arrow_op, inline_or_block($, $.type_expression)),
      $.non_arrow_type,
    )),

    //
    // Only the left-hand side of an arrow may use comma-separated parameters.
    // Parenthesised comma lists remain tuples, not parameter groups.
    function_type_domain: $ => choice(
      $.non_arrow_type,
      seq(
        $.non_arrow_type,
        repeat1(seq(repeat($.newline), $.comma, repeat($.newline), $.non_arrow_type))
      ),
    ),

    // simple where-clause constraint.
    constraint_clause: $ => seq(
      $.kw_where,
      field("type_var", $.identifier),
      $.colon,
      field("constraint", $.non_arrow_type),
    ),

    // non-arrow type forms (parenthesized arguments only).
    non_arrow_type: $ => choice(
      $.type_primary,
      $.type_tuple,
      $.type_record,
      $.tag_union_type,
    ),

    // atomic type forms.
    type_primary: $ => choice(
      seq($.type_name, $.type_argument_list),
      $.type_name,
      alias("_", $.type_wildcard),
      alias("*", $.type_star),
      $.parenthesized_type,
    ),

    //
    // Qualified type name without arguments.
    // Arguments are handled separately by type_primary or type_application.
    // Example:
    //   Foo
    //   Mod.Foo
    type_name: $ => seq(
      $.name,
      repeat(seq(token.immediate("."), $.name))
    ),

    // explicit parenthesised type argument list.
    type_argument_list: $ => seq(
      token.immediate("("),
      optional(seq(
        field("first", $.type_expression),
        field("rest", repeat(seq(repeat($.newline), $.comma, repeat($.newline), $.type_expression))),
        optional(seq(repeat($.newline), $.comma)),
      )),
      $.rparen,
    ),

    // record type field.
    // record type field (allows keywords as field names).
    record_type_field: $ => seq($.field_name, $.colon, inline_or_block($, $.type_expression)),

    //
    // Tag union type:
    //   [Some(a), None]
    tag_union_type: $ => layoutBracket($, $.lbracket, $.rbracket, $.tag_union_member),

    // one tag constructor inside a tag union type.
    tag_union_member: $ => seq(
      $.tag_name,
      optional(seq($.lparen, commaSep1Trail($, $.type_expression, $.comma, $.newline), $.rparen))
    ),

    // tuple type.
    type_tuple: $ => tuple_like($, $.type_expression),

    // grouped type expression.
    parenthesized_type: $ => seq($.lparen, $.type_expression, $.rparen),

    // literal forms available in both expressions and patterns.
    literal: $ => choice(
      $.int_literal,
      $.float_literal,
      $.string,
      $.multiline_string,
      alias("true", $.bool_literal),
      alias("false", $.bool_literal),
    ),

    // decimal/scientific floating-point formats with optional f32/f64 suffix.
    float_literal: $ => token(choice(
      /[0-9][0-9_]*\.[0-9][0-9_]*(?:[eE][+-]?[0-9_]+)?(?:f32|f64)?/,
      /[0-9][0-9_]*\.(?:[eE][+-]?[0-9_]+)?(?:f32|f64)?/,
      /\.[0-9][0-9_]*(?:[eE][+-]?[0-9_]+)?(?:f32|f64)?/,
      /[0-9][0-9_]*[eE][+-]?[0-9_]+(?:f32|f64)?/,
    )),

    // integer literal formats with optional signed/unsigned width suffixes.
    int_literal: $ => token(choice(
      /0[bB][01][01_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?/,
      /0[oO][0-7][0-7_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?/,
      /0[xX][0-9a-fA-F][0-9a-fA-F_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?/,
      /[0-9][0-9_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?/,
    )),

    //
    // Normal string with escapes and interpolation.
    // Interpolation starts with \( and ends at the matching parser-level ).
    string: $ => seq(
      '"',
      repeat(choice(
        $.string_text,
        $.escape_sequence,
        $.interpolation,
      )),
      '"',
    ),

    //
    // Triple-quoted multiline string with interpolation and controlled quote tokenisation.
    multiline_string: $ => seq(
      '"""',
      repeat(choice(
        $.multiline_text,
        $.escape_sequence,
        $.interpolation,
        $.multiline_quote,
        $.multiline_double_quote,
      )),
      '"""',
    ),

    // embedded expression interpolation in strings.
    interpolation: $ => seq(
      $.interpolation_start,
      $.expression,
      $.rparen,
    ),

    // token for the start of interpolation.
    interpolation_start: $ => token(/\\\(/),

    // plain single-line string content excluding quotes, backslashes, and newlines.
    string_text: $ => token(/[^"\\\n]+/),

    //
    // Multiline quote token design deliberately avoids consuming the closing """ delimiter.
    multiline_text: $ => token(/[^\\"]+/),
    multiline_quote: $ => token(/"[^"]/),
    multiline_double_quote: $ => token(/""[^"]/),

    // supported escape sequences.
    escape_sequence: $ => token(/\\(u\([0-9A-Fa-f]{1,8}\)|[\\'"ntrbfv])/),

    // comment forms, all treated as extras.
    doc_comment: _ => token(prec(2, /\/\/\/[^\n]*/)),
    line_comment: _ => token(prec(1, /\/\/[^\n]*/)),
    block_comment: $ => token(prec(-3,
      seq(
        "</",
        repeat(choice(
          /[^/]/,
          /\/[^>]/,
        )),
        "/>",
      ),
    )),


    //
    // Lowercase-style identifiers, optionally prefixed by underscores and optionally ending in !.
    // Cannot match reserved keywords (see keyword declarations below).
    // Token precedence 1; keywords have precedence 2 and will be preferred by the lexer.
    identifier: $ => token(prec(1, /(_*[a-z][a-zA-Z0-9_]*!?)/)),

    // constructor/type/tag names are uppercase-initial.
    tag_name: $ => token(/(_*[A-Z][a-zA-Z0-9_]*)/),

    // name may be lowercase identifier or uppercase tag/type name.
    name: $ => choice($.identifier, $.tag_name),

    // dotted qualified identifier/type path.
    long_identifier: $ => prec.left(seq(
      $.name,
      repeat(seq(token.immediate("."), $.name))
    )),

    // placeholder expression token.
    placeholder: $ => token("__"),

    //
    // Reserved keywords (token precedence 2, identifier precedence 1).
    // These keywords cannot be used as identifiers anywhere in the grammar.
    // Tree-Sitter's lexer prefers the higher-precedence keyword tokens.
    // Reserved words:
    //   pub, let, cert, expect, if, then, else, when, is, in, where, with,
    //   ability, implement, module, use, build, for, type, sig, fn,
    //   or, and, not, as
    kw_pub: $ => token(prec(2, "pub")),
    kw_let: $ => token(prec(2, "let")),
    kw_cert: $ => token(prec(2, "cert")),
    kw_expect: $ => token(prec(2, "expect")),
    kw_if: $ => token(prec(2, "if")),
    kw_then: $ => token(prec(2, "then")),
    kw_else: $ => token(prec(2, "else")),
    kw_when: $ => token(prec(2, "when")),
    kw_is: $ => token(prec(2, "is")),
    kw_in: $ => token(prec(2, "in")),
    kw_where: $ => token(prec(2, "where")),
    kw_with: $ => token(prec(2, "with")),
    kw_ability: $ => token(prec(2, "ability")),
    kw_implement: $ => token(prec(2, "implement")),
    kw_module: $ => token(prec(2, "module")),
    kw_use: $ => token(prec(2, "use")),
    kw_build: $ => token(prec(2, "build")),
    kw_for: $ => token(prec(2, "for")),
    kw_type: $ => token(prec(2, "type")),
    kw_sig: $ => token(prec(2, "sig")),
    kw_fn: $ => token(prec(2, "fn")),
    kw_or: $ => token(prec(2, "or")),
    kw_and: $ => token(prec(2, "and")),
    kw_not: $ => token(prec(2, "not")),
    kw_as: $ => token(prec(2, "as")),

    // punctuation and operator tokens.
    lparen: $ => "(",
    rparen: $ => ")",
    lbracket: $ => "[",
    rbracket: $ => "]",
    lbrace: $ => "{",
    rbrace: $ => "}",
    // tuple constructor: #{x, y}
    lbrace_hash: $ => token.immediate("#{"),
    comma: $ => ",",
    colon: $ => ":",
    equals: $ => token(prec(2, "=")),
    dot: $ => ".",

    //
    // |> must tokenise before plain | to avoid partial matches.
    pipe: $ => token("|>"),
    pipe_bar: $ => token("|"),

    or_op: $ => $.kw_or,
    and_op: $ => $.kw_and,
    not_kw: $ => $.kw_not,

    plus: $ => "+",
    minus: $ => "-",
    star: $ => "*",
    slash: $ => "/",
    double_slash: $ => "//",
    percent: $ => "%",

    //
    // Longer comparison operators are given higher precedence to avoid ambiguity.
    eq_op: $ => token(prec(3, "==")),
    ne_op: $ => token(prec(3, "!=")),
    le_op: $ => token(prec(4, "<=")),
    ge_op: $ => token(prec(4, ">=")),
    lt_op: $ => token(prec(3, "<")),
    gt_op: $ => token(prec(3, ">")),

    arrow_op: $ => "->",
    try_op: $ => "?",

    // record type literal syntax.
    type_record: $ => layoutBracket($, $.lbrace, $.rbrace, $.record_type_field),

    // wildcard and star type atoms.
    type_wildcard: $ => "_",
    type_star: $ => "*",
  },
});

//
// Generic single-line delimited list helper with optional trailing comma.
function singleLineBracket(open, commaToken, item, close) {
  return seq(
    open,
    optional(seq(
      item,
      repeat(seq(commaToken, item)),
      optional(commaToken),
    )),
    close,
  );
}

//
// Attach any leading newlines directly to the rule.
// Used to keep layout ownership local to the consuming construct.
function withLeadingNewlines($, rule) {
  return seq(repeat($.newline), rule);
}

//
// Strict indented block form.
// Requires a newline immediately before the indented body.
function indented_block($, rule) {
  return seq($.newline, $.indent, withLeadingNewlines($, rule), repeat($.newline), $.dedent);
}

//
// Unified body helper:
// - same line: = expr
// - indented:  =\n  expr
function inline_or_block($, rule) {
  return choice(
    rule,
    indented_block($, rule),
  );
}

//
// Generic comma-list helper where items may own leading newlines.
function list_items($, itemRule) {
  return seq(
    withLeadingNewlines($, itemRule),
    repeat(seq(
      repeat($.newline),
      $.comma,
      withLeadingNewlines($, itemRule),
    )),
    optional(seq(repeat($.newline), $.comma)),
  );
}

//
// Shared tuple parser for expression tuples and type tuples.
// Uses first/rest field naming for downstream consistency.
// Syntax: #{x, y} not (x, y)
function tuple_like($, itemRule) {
  return choice(
    seq(
      $.lbrace_hash,
      field("first", itemRule),
      $.comma,
      field("rest", commaSep1Trail($, itemRule, $.comma, $.newline)),
      $.rbrace,
    ),
    seq(
      $.lbrace_hash,
      repeat1($.newline),
      $.indent,
      field("first", withLeadingNewlines($, itemRule)),
      repeat($.newline),
      $.comma,
      field("rest", seq(
        withLeadingNewlines($, itemRule),
        repeat(seq(
          repeat($.newline),
          $.comma,
          withLeadingNewlines($, itemRule),
        )),
        optional(seq(repeat($.newline), $.comma)),
      )),
      repeat($.newline),
      $.dedent,
      $.rbrace,
    ),
  );
}

//
// Helper: function argument list using 'with' keyword without parentheses.
// Arguments are postfix_chains (not full expressions) to provide natural boundaries.
// Syntax: func with x, y (single-line, no newlines between args)
// Multiline: func with
//   x, y
// Single-line and multiline are distinct: single-line has no leading newline after 'with',
// multiline has immediate newline+indent after 'with'.
function with_call_suffix($) {
  return choice(
    // Single-line: with arg, arg, ... (NO NEWLINES between arguments)
    // Use prec.right to prefer shifting on comma (continue collecting arguments)
    prec.right(seq(
      $.kw_with,
      field("first", $.expression),
      field("rest", repeat(seq($.comma, $.expression))),
      optional($.comma),
    )),
    // Multi-line: with\n  arg,\n  arg
    seq(
      $.kw_with,
      repeat1($.newline),
      $.indent,
      field("first", withLeadingNewlines($, $.expression)),
      repeat($.newline),
      $.comma,
      field("rest", seq(
        withLeadingNewlines($, $.expression),
        repeat(seq(
          repeat($.newline),
          $.comma,
          withLeadingNewlines($, $.expression),
        )),
        optional(seq(repeat($.newline), $.comma)),
      )),
      repeat($.newline),
      $.dedent,
    ),
  );
}

//
// Multiline delimited list helper using indentation.
function multiLineBracket($, open, commaToken, item, close) {
  return seq(
    open,
    $.newline,
    $.indent,
    commaSep1Trail($, item, commaToken, $.newline),
    repeat($.newline),
    $.dedent,
    close,
  );
}

//
// Layout-aware bracketed collection: single-line or indented multiline form.
function layoutBracket($, open, close, item) {
  return choice(
    singleLineBracket(open, $.comma, item, close),
    multiLineBracket($, open, $.comma, item, close),
  );
}

// optional comma-separated sequence.
function commaSepTrail($, rule, commaToken, sepToken) {
  return optional(commaSep1Trail($, rule, commaToken, sepToken));
}

// one-or-more comma-separated sequence with optional trailing comma.
function commaSep1Trail($, rule, commaToken, sepToken) {
  return seq(
    rule,
    repeat(seq(repeat(sepToken), commaToken, repeat(sepToken), rule)),
    optional(seq(repeat(sepToken), commaToken)),
  );
}


// Single-line record literal helper supporting:
//   { a: 1 }
//   { a: 1, ..base }
//   { ..base }
function singleLineRecordExpression($, field) {
  return seq(
    $.lbrace,
    optional(choice(
      seq(
        field,
        repeat(seq($.comma, field)),
        optional(seq($.comma, "..", $.expression))
      ),
      seq("..", $.expression)
    )),
    $.rbrace,
  );
}


// Multiline record literal helper supporting fields and optional spread.
function multiLineRecordExpression($, field) {
  return seq(
    $.lbrace,
    $.newline,
    $.indent,
    optional(choice(
      seq(
        field,
        repeat(seq(optional($.newline), $.comma, optional($.newline), field)),
        optional(seq(optional($.newline), $.comma, optional($.newline), "..", $.expression))
      ),
      seq("..", $.expression)
    )),
    repeat($.newline),
    $.dedent,
    $.rbrace,
  );
}
