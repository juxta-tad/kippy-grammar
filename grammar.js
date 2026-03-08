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


// Keyword helper: creates a keyword token with standard precedence (2)
function kw(s) {
  return $ => token(prec(2, s));
}

// Operator helper: creates an operator token with specified precedence
function op(p, s) {
  return $ => token(prec(p, s));
}

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

  supertypes: $ => [
    $.expression,
    $.postfix_expression,
  ],

  inline: $ => [
    $.field_name,
  ],

  rules: {
    // A source file is a newline-separated list of module items.
    // Leading and trailing blank lines are allowed.
    // Multiple items cannot share one line.
    source_file: $ => seq(
      repeat($.newline),
      optional(seq(
        $.module_item,
        repeat(seq(
          repeat1($.newline),
          $.module_item,
        )),
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
      named_indented_list($, "items", $.module_item),
    ),

    // Type alias / type declaration.
    // Parameters are bare identifiers after the type name.
    type_declaration: $ => seq(
      $.kw_type,
      field("name", $.type_name),
      optional($.type_parameter_list),
      $.equals,
      field("value", choice(
        $.type_expression,
        $.type_variant_block,
      )),
    ),

    // Type parameter list: (A, B, C)
    type_parameter_list: $ => seq(
      $.lparen,
      commaSep1Trail($, $.identifier, $.comma, $.newline),
      $.rparen,
    ),

    // Indented variant block for type declarations:
    //   type Maybe(A) =
    //     | Some(A)
    //     | None
    type_variant_block: $ => seq(
      $.newline,
      $.indent,
      $.type_variant,
      repeat(seq(repeat($.newline), $.type_variant)),
      repeat($.newline),
      $.dedent,
    ),

    // one type variant: | TagName or | TagName(args)
    type_variant: $ => seq(
      $.pipe_bar,
      field("name", $.tag_name),
      optional(seq($.lparen, commaSep1Trail($, $.type_expression, $.comma, $.newline), $.rparen))
    ),


    // Standalone annotation node used by ability method declarations.
    // Supports leading attributes and same-line or indented type bodies.
    annotation: $ => seq(
      attribute_prefix($),
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

    // Value definitions support:
    //   let name : Type
    //   let name = expr
    //   let name : Type = expr
    // Also supports attributes and pub modifiers.
    let_binding: $ => seq(
      attribute_prefix($),
      optional($.kw_pub),
      $.kw_let,
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

    // Attributes with optional arguments.
    // Arguments must be on the same line as the attribute name (token.immediate).
    // Examples:
    //   @deprecated
    //   @inline
    //   @optimize.inline
    //   @deprecated("reason")
    //   @optimize(inline: true)
    attribute: $ => seq(
      "@",
      $.long_identifier,
      optional($.attribute_arguments_inline),
    ),

    // attribute argument list (arguments must stay on same line as opening paren).
    attribute_arguments_inline: $ => seq(
      token.immediate("("),
      optional(commaSepTrail($, $.attribute_argument, $.comma, $.newline)),
      $.rparen,
    ),

    // attribute argument: either expression or named argument.
    attribute_argument: $ => choice(
      $.expression,
      seq(field("name", $.identifier), $.colon, field("value", $.expression))
    ),

    // implement an ability for a concrete type.
    implementation: $ => seq(
      $.kw_implement,
      field("ability", $.type_name),
      $.kw_for,
      field("type", $.type_name),
      named_indented_list($, "methods", $.let_binding),
    ),


    // Ability declaration with indented method annotations.
    // Example:
    //   ability Writer
    //     write: File -> Bytes -> Void
    //   ability Reader
    //     read: File -> Bytes
    ability_declaration: $ => seq(
      attribute_prefix($),
      $.kw_ability,
      field("name", $.type_name),
      named_indented_list($, "methods", $.annotation, { atLeastOne: true }),
    ),

    // assertion/expectation form.
    expect_statement: $ => seq($.kw_expect, field("value", $.expression)),


    // Assignment LHS is limited to lowercase-style identifiers and dotted paths.
    // This avoids ambiguity with constructor/type names.
    binding_target: $ => prec(1, dotted1($.identifier, $.identifier)),

    // expression entry point.
    expression: $ => $.pipe_expression,

    // pipeline is lowest-precedence expression form.
    pipe_expression: $ => right_assoc_chain(PREC.PIPE, $.or_expression, $.pipe),

    or_expression: $ => left_assoc_chain(PREC.OR, $.and_expression, $.or_op),

    and_expression: $ => left_assoc_chain(PREC.AND, $.compare_expression, $.and_op),


    // Comparison allows at most one comparator per node.
    // Chained comparisons like a < b < c are not parsed as a single expression here.
    compare_expression: $ => prec.left(PREC.COMPARE, seq(
      $.add_expression,
      optional(seq(choice($.le_op, $.ge_op, $.eq_op, $.ne_op, $.lt_op, $.gt_op), $.add_expression)),
    )),

    add_expression: $ => left_assoc_chain(PREC.ADD, $.mul_expression, choice($.plus, $.minus)),

    mul_expression: $ => left_assoc_chain(PREC.MUL, $.unary_expression, choice($.star, $.slash, $.double_slash, $.percent)),

    // unary negation and logical not bind tighter than binary operators.
    unary_expression: $ => choice(
      prec.right(PREC.UNARY, seq(choice($.minus, $.not_kw, $.kw_cert), $.unary_expression)),
      $.postfix_expression,
    ),


    // Unified postfix chain:
    //   value.field
    //   value?
    //   func with x, y
    //   get? with x .field?
    // Postfix forms are parsed left-to-right in a single rule.
    postfix_chain: $ => prec.left(PREC.POSTFIX, seq(
      $.primary_expression,
      repeat(choice($.call_suffix, $.projection_suffix, $.try_op)),
    )),

    // alias for postfix_chain kept as the expression-level postfix rule.
    postfix_expression: $ => $.postfix_chain,

    // function call suffix using 'with' keyword.
    // Syntax:
    //   func with x, y
    //   func with
    //     x,
    //     y
    call_suffix: $ => with_call_suffix($),

    // field/property access suffix.
    // Syntax:
    //   obj.field
    //   obj.0 (tuple index)
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


    // Record literal:
    //   { a: 1, b: 2 }
    //   { a: 1, ..base }
    //   { ..base }
    record_expression: $ => choice(
      singleLineRecordExpression($, $.record_field),
      multiLineRecordExpression($, $.record_field),
    ),


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


    // Tuple pattern must contain a comma so it cannot be confused with grouping.
    // Syntax: #{x, y}
    tuple_pattern: $ => seq(
      $.lbrace_hash,
      $.pattern,
      $.comma,
      commaSepTrail($, $.pattern, $.comma, $.newline),
      $.rbrace
    ),


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


    // Function types are parsed with arrow precedence lower than non-arrow types.
    // Supports:
    //   a -> b
    //   a, b -> c
    //   a -> b -> c
    type_expression: $ => prec.right(choice(
      seq(
        field("left", choice(
          $.type_function_params,
          $.non_arrow_type,
        )),
        $.arrow_op,
        field("right", inline_or_block($, $.type_expression)),
      ),
      $.non_arrow_type,
    )),

    // Type function parameters: comma-separated list of types on the left of an arrow.
    // Must have at least 2 items. Commas must follow immediately (no leading newlines).
    type_function_params: $ => seq(
      field("first", $.non_arrow_type),
      repeat1(seq(
        $.comma,
        repeat($.newline),
        field("rest", $.non_arrow_type),
      )),
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
    // Arguments are handled separately by type_primary.
    // Example:
    //   Foo
    //   Mod.Foo
    type_name: $ => dotted1($.name, $.name),

    // explicit parenthesised type argument list.
    type_argument_list: $ => seq(
      token.immediate("("),
      optional(seq(
        field("first", $.type_expression),
        field("rest", repeat(seq($.comma, repeat($.newline), $.type_expression))),
        optional(seq(repeat($.newline), $.comma)),
      )),
      $.rparen,
    ),

    // record type field (allows keywords as field names).
    record_type_field: $ => seq($.field_name, $.colon, inline_or_block($, $.type_expression)),


    // tuple type.
    type_tuple: $ => tuple_like($, $.non_arrow_type),

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

    // Lowercase-style identifiers, optionally prefixed by underscores and optionally ending in !.
    // Trailing ! marks effectful functions/values.
    // Cannot match reserved keywords (see keyword declarations below).
    // Token precedence 1; keywords have precedence 2 and will be preferred by the lexer.
    identifier: $ => token(prec(1, /(_*[a-z][a-zA-Z0-9_]*!?)/)),

    // constructor/type/tag names are uppercase-initial.
    tag_name: $ => token(/(_*[A-Z][a-zA-Z0-9_]*)/),

    // name may be lowercase identifier or uppercase tag/type name.
    name: $ => choice($.identifier, $.tag_name),

    // dotted qualified identifier/type path.
    long_identifier: $ => prec.left(dotted1($.name, $.name)),

    // placeholder expression token.
    placeholder: $ => token("__"),

    // Reserved
    kw_pub: $ => token(prec(2, "pub")),
    kw_let: $ => token(prec(2, "let")),
    kw_cert: $ => token(prec(2, "cert")),
    kw_expect: $ => token(prec(2, "expect")),
    kw_if: $ => token(prec(2, "if")),
    kw_then: $ => token(prec(2, "then")),
    kw_else: kw("else"),
    kw_when: kw("when"),
    kw_is: kw("is"),
    kw_in: kw("in"),
    kw_where: kw("where"),
    kw_with: kw("with"),
    kw_ability: kw("ability"),
    kw_implement: kw("implement"),
    kw_module: kw("module"),
    kw_use: kw("use"),
    kw_build: kw("build"),
    kw_for: kw("for"),
    kw_type: kw("type"),
    kw_sig: kw("sig"),
    kw_fn: kw("fn"),
    kw_or: kw("or"),
    kw_and: kw("and"),
    kw_not: kw("not"),
    kw_as: kw("as"),

    // punctuation and operator tokens.
    lparen: $ => "(",
    rparen: $ => ")",
    lbracket: $ => "[",
    rbracket: $ => "]",
    lbrace: $ => "{",
    rbrace: $ => "}",
    // tuple constructor: #{x, y}
    lbrace_hash: $ => token("#{"),
    comma: $ => ",",
    colon: $ => ":",
    equals: op(2, "="),
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
    eq_op: op(3, "=="),
    ne_op: op(3, "!="),
    le_op: op(4, "<="),
    ge_op: op(4, ">="),
    lt_op: op(3, "<"),
    gt_op: op(3, ">"),

    arrow_op: $ => "->",
    try_op: $ => "?",

    // record type literal syntax.
    type_record: $ => layoutBracket($, $.lbrace, $.rbrace, $.record_type_field),

    // wildcard and star type atoms.
    type_wildcard: $ => "_",
    type_star: $ => "*",
  },
});


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


// Attach any leading newlines directly to the rule.
// Used to keep layout ownership local to the consuming construct.
function withLeadingNewlines($, rule) {
  return seq(repeat($.newline), rule);
}

// Strict indented block form.
// Requires a newline immediately before the indented body.
function indented_block($, rule) {
  return seq($.newline, $.indent, withLeadingNewlines($, rule), repeat($.newline), $.dedent);
}


// Unified body helper:
// - same line: = expr
// - indented:  =\n  expr
function inline_or_block($, rule) {
  return choice(
    rule,
    indented_block($, rule),
  );
}


// Dotted name helper for qualified identifiers.
// Matches: head (. tail)*
// Used for: type_name, long_identifier, binding_target
function dotted1(head, tail) {
  return seq(
    head,
    repeat(seq(token.immediate("."), tail)),
  );
}


// Attribute prefix for declarations that support attributes.
// Handles optional attributes followed by optional newlines before the declaration.
function attribute_prefix($) {
  return repeat(seq($.attribute, optional($.newline)));
}


// Left-associative operator chain precedence helper.
// Produces a flat concrete syntax tree: operand (operator operand)*
function left_assoc_chain(precValue, operand, operator) {
  return prec.left(precValue, seq(
    operand,
    repeat(seq(operator, operand)),
  ));
}


// Right-associative operator chain precedence helper.
// Produces a flat concrete syntax tree while assigning right-associative precedence.
function right_assoc_chain(precValue, operand, operator) {
  return prec.right(precValue, seq(
    operand,
    repeat(seq(operator, operand)),
  ));
}


// Indented list helper for bodies with optional or required items.
// Syntax: newline, indent, items, dedent
// Used for: module items, implementation methods, ability methods, type variants, when arms, etc.
function named_indented_list($, fieldName, itemRule, { atLeastOne = false } = {}) {
  const body = atLeastOne
    ? seq(itemRule, repeat(seq(repeat($.newline), itemRule)), repeat($.newline))
    : repeat(seq(itemRule, repeat($.newline)));

  return seq(
    $.newline,
    $.indent,
    field(fieldName, body),
    $.dedent,
  );
}

// Shared tuple parser for expression tuples and type tuples.
// Explicitly requires at least 2 items: first, comma, second, then optional rest.
// Syntax: #{x, y}
function tuple_like($, itemRule) {
  return choice(
    seq(
      $.lbrace_hash,
      field("first", itemRule),
      $.comma,
      field("second", itemRule),
      repeat(seq(
        $.comma,
        field("rest", itemRule),
      )),
      optional($.comma),
      $.rbrace,
    ),
    seq(
      $.lbrace_hash,
      repeat1($.newline),
      $.indent,
      field("first", withLeadingNewlines($, itemRule)),
      repeat($.newline),
      $.comma,
      field("second", withLeadingNewlines($, itemRule)),
      repeat(seq(
        repeat($.newline),
        $.comma,
        withLeadingNewlines($, itemRule),
      )),
      optional(seq(repeat($.newline), $.comma)),
      repeat($.newline),
      $.dedent,
      $.rbrace,
    ),
  );
}


// Helper: function argument list using 'with' keyword without parentheses.
// Arguments are full expressions.
// Syntax:
//   func with x, y
//   func with
//     x,
//     y
// Single-line and multiline forms are distinct: single-line has no newline after 'with',
// multiline requires an indented block immediately after 'with'.
// Effects are marked by ! at the end of function/value names, not on the call.
function with_call_suffix($) {
  return choice(
    // Single-line: with arg, arg, ...
    // Use prec.right to prefer shifting on comma and continue collecting arguments.
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
