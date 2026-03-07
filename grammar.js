
const PREC = {
  PIPE: 1,
  OR: 2,
  AND: 3,
  COMPARE: 4,
  ADD: 5,
  MUL: 6,
  UNARY: 7,
  POSTFIX_CALL: 8,
  POSTFIX_FIELD: 9,
  POSTFIX_SPACE_APP: 10,
};

module.exports = grammar({
  name: "kippy",

  word: $ => $.identifier,

  externals: $ => [
    $.newline,
    $.indent,
    $.dedent,
  ],

  extras: $ => [
    /[ \t\r\f]+/,
    $.doc_comment,
    $.line_comment,
    $.block_comment,
  ],
  rules: {
    // Enforce newline boundaries between module items (no two items on same line)
    // Leading newlines allowed, then repeat: item + one-or-more-newlines
    // Trailing newlines at EOF are optional
    source_file: $ => seq(
      repeat($.newline),
      repeat(seq(
        $.module_item,
        repeat($.newline),
      )),
    ),

    module_item: $ => choice(
      $.use_statement,
      $.module_declaration,
      $.type_declaration,
      $.value_definition,
      $.signature,
      $.expect_statement,
      $.implementation,
      $.ability_declaration,
    ),

    use_statement: $ => seq(
      $.kw_use,
      $.long_identifier,
    ),

    module_declaration: $ => seq(
      $.kw_module,
      field("name", $.type_name),
      $.kw_with,
      $.newline,
      $.indent,
      field("items", seq(
        repeat(seq($.module_item, repeat($.newline))),
      )),
      $.dedent,
    ),

    type_declaration: $ => seq(
      $.kw_type,
      field("name", $.type_name),
      repeat(field("param", $.identifier)),
      $.equals,
      field("value", $.type_expression),
    ),

    annotation: $ => seq(
      repeat(seq($.attribute, optional($.newline))),
      field("name", $.assignment_lhs),
      ":",
      field("type", same_line_or_with_block($, $.type_expression)),
      optional(field("constraints", $.constraint_clause)),
    ),

    signature: $ => seq(
      field("name", $.identifier),
      ":",
      field("type", same_line_or_with_block($, $.type_expression)),
      optional(field("constraints", $.constraint_clause)),
    ),

    value_definition: $ => seq(
      repeat(seq($.attribute, optional($.newline))),
      optional($.kw_pub),
      $.kw_let,
      optional($.kw_cert),
      field("name", $.assignment_lhs),
      choice(
        // Signature-only: let name : Type (where ...)?
        seq(
          ":",
          field("type", same_line_or_with_block($, $.type_expression)),
          optional(field("constraints", $.constraint_clause)),
        ),
        // Definition: let name (: Type)? = expr
        seq(
          optional(seq(
            ":",
            field("type", same_line_or_with_block($, $.type_expression)),
          )),
          $.equals,
          field("value", same_line_or_indent_block($, $.expression)),
        ),
      ),
    ),

    // Attributes use function-call syntax: @name or @name(args)
    // Reuses call_suffix and arg_list from function call grammar
    // Supports qualified names: @intrinsic.dispatch(), @config.option()
    attribute: $ => seq(
      "@",
      $.long_identifier,
      optional($.call_suffix),
    ),

implementation: $ => seq(
      $.kw_implement,
      field("ability", $.type_name),
      $.kw_for,
      field("type", $.type_name),
    ),

    ability_declaration: $ => seq(
      repeat(seq($.attribute, optional($.newline))),
      $.kw_ability,
      field("name", $.type_name),
      optional(seq(
        $.kw_with,
        $.newline,
        $.indent,
        field("methods", seq(
          $.annotation,
          repeat(seq(repeat($.newline), $.annotation)),
        )),
        repeat($.newline),
        $.dedent,
      )),
    ),

    expect_statement: $ => seq($.kw_expect, field("value", $.expression)),

    // Value binders must be lowercase to avoid ambiguity with type constructors
    // let <lowercase_name> = ... (value definition)
    // vs Let Foo = ... (would suggest type/constructor)
    assignment_lhs: $ => prec(1, seq(
      $.identifier,
      repeat(seq(token.immediate("."), $.identifier)),
    )),

    expression: $ => $.pipe_expression,

    pipe_expression: $ => prec.right(PREC.PIPE, seq(
      $.or_expression,
      repeat(seq($.pipe, $.or_expression)),
    )),

    or_expression: $ => prec.left(PREC.OR, seq(
      $.and_expression,
      repeat(seq($.or_op, $.and_expression)),
    )),

    and_expression: $ => prec.left(PREC.AND, seq(
      $.compare_expression,
      repeat(seq($.and_op, $.compare_expression)),
    )),

    compare_expression: $ => prec.left(PREC.COMPARE, seq(
      $.add_expression,
      optional(seq(choice($.le_op, $.ge_op, $.eq_op, $.ne_op, $.lt_op, $.gt_op), $.add_expression)),
    )),

    add_expression: $ => prec.left(PREC.ADD, seq(
      $.mul_expression,
      repeat(seq(choice($.plus, $.minus), $.mul_expression)),
    )),

    mul_expression: $ => prec.left(PREC.MUL, seq(
      $.unary_expression,
      repeat(seq(choice($.star, $.slash, $.double_slash, $.percent), $.unary_expression)),
    )),

    unary_expression: $ => choice(
      prec.right(PREC.UNARY, seq(choice($.minus, $.not_kw), $.unary_expression)),
      $.postfix_expression,
    ),

    // Unified postfix chain: call, field, and try all at same level
    // Allows: f()?, f?.(), f?().x, getValue?()(x).baz?
    // This single chain handles all combinations without ordering constraints
    postfix_atom: $ => prec.left(PREC.POSTFIX_FIELD, seq(
      $.primary_expression,
      repeat(choice($.call_suffix, $.field_suffix, $.try_op)),
    )),

    // Postfix hierarchy (tightest to loosest): space_app > postfix_atom
    // This binding order means: f g.x is (f g).x, not f (g.x)
    postfix_expression: $ => choice(
      $.space_application_expression,
      $.postfix_atom,
    ),

    // Space application: postfix_atom followed by one or more space-separated args
    // The 'let' keyword on value_definition eliminates shift-reduce conflicts:
    // Module items cannot start with a bare identifier (must start with 'let')
    // Therefore no ambiguity between "continue space_application" and "new module_item"
    // This allows all forms: f x y, f (x) (y), f x (y), f g(x), f 1 2
    space_application_expression: $ => prec.left(PREC.POSTFIX_SPACE_APP, seq(
      $.postfix_atom,
      repeat1($.space_sep_arg),  // One or more args (repeat1, not space_sep_arg + repeat)
    )),

    // Space-separated argument: postfix_atom allows calls, field access, and try
    space_sep_arg: $ => $.postfix_atom,

    call_suffix: $ => prec(2, arg_list($, $.expression)),

    field_suffix: $ => seq(
      $.dot,
      field("field", choice($.identifier, $.int_index)),
    ),

    int_index: $ => token(/[0-9]+/),

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

    list_expression: $ => layoutBracket($, $.lbracket, $.rbracket, $.expression),

    // Record expression: { field: value, field: value } or { field: value, ..base }
    record_expression: $ => choice(
      singleLineRecordExpression($, $.record_field),
      multiLineRecordExpression($, $.record_field),
    ),

    // Record builder: applicative composition for parsers, decoders, validators
    // Syntax: build builder_fn { field1: comp1, field2: comp2, ... }
    record_builder: $ => seq(
      $.kw_build,
      field("builder", $.long_identifier),
      layoutBracket($, $.lbrace, $.rbrace, $.record_field),
    ),

    // Record field naming: name/value pattern for consistent downstream tooling
    // Every record field uses field("name", ...) and field("value", ...)
    record_field: $ => seq(field("name", $.identifier), $.colon, field("value", same_line_or_with_block($, $.expression))),

    tuple_expression: $ => tuple_like($, $.expression),

    parenthesized_expression: $ => seq(
      $.lparen,
      field("value", $.expression),
      $.rparen,
    ),

    block_expression: $ => seq(
      $.lparen,
      repeat1($.newline),
      $.indent,
      choice(
        // Value-only block: no definitions, just expression with leading newlines
        field("value", withLeadingNewlines($, $.expression)),
        // Block with definitions: defs (zero-or-more), blank lines, 'in' keyword, value
        // Policy: the final expression consumes its own leading newlines
        seq(
          repeat(seq($.value_definition, repeat($.newline))),
          $.kw_in,
          field("value", withLeadingNewlines($, $.expression)),
        ),
      ),
      repeat($.newline),
      $.dedent,
      $.rparen,
    ),

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

    // Pattern matching in when expressions
    // Top level: pattern with optional guard
    pattern: $ => seq(
      $.or_pattern,
      optional(seq($.kw_if, field("guard", $.expression)))
    ),

    // Or-patterns: p1 | p2 | p3
    or_pattern: $ => prec.left(seq(
      $.as_pattern,
      repeat(seq($.pipe_bar, $.as_pattern))
    )),

    // As-patterns: p as binding
    as_pattern: $ => choice(
      seq($.atomic_pattern, $.kw_as, field("binding", $.identifier)),
      $.atomic_pattern
    ),

    // Atomic pattern types (cannot be extended with `as` or `|`)
    atomic_pattern: $ => choice(
      $.literal,
      $.wildcard_pattern,
      $.identifier,  // binding pattern
      $.tag_pattern,
      $.list_pattern,
      $.tuple_pattern,
      $.record_pattern,
      seq($.lparen, $.pattern, $.rparen)  // parenthesized pattern
    ),

    wildcard_pattern: $ => "_",

    // Non-parenthesized atomic patterns (for space-applied tag arguments)
    // Excludes all forms starting with ( to avoid ambiguity with Tag(x) syntax:
    // - seq(lparen, pattern, rparen) [parenthesized pattern]
    // - tuple_pattern [starts with lparen]
    non_paren_atomic_pattern: $ => choice(
      $.literal,
      $.wildcard_pattern,
      $.identifier,
      $.tag_pattern,
      $.list_pattern,
      $.record_pattern,
    ),

    // Tag pattern: Tag or Tag(...args) or Tag arg
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

    // List pattern: [] or [x, y] or [x, ..rest]
    // Allows full patterns inside: [x as y], [A | B], etc.
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

    // Rest pattern: ..identifier
    rest_pattern: $ => seq(
      "..",
      field("binding", $.identifier)
    ),

    // Tuple pattern: (x,) or (x, y) - requires at least one comma to distinguish from parenthesized pattern
    // Allows full patterns inside: (x as y, z), (A | B, C), etc.
    tuple_pattern: $ => seq(
      $.lparen,
      $.pattern,
      $.comma,
      commaSepTrail($, $.pattern, $.comma, $.newline),
      $.rparen
    ),

    // Record pattern: { age, name: _ } or { age, .. }
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

    // Record pattern field: age or age: pattern or name: _
    // Allows full patterns: { field: A | B }, { age: x as y }, etc.
    record_pattern_field: $ => choice(
      seq($.identifier, ":", $.pattern),
      $.identifier  // shorthand: { age } equivalent to { age: age }
    ),

    when_arm: $ => seq(
      field("pattern", $.pattern),
      $.arrow_op,
      field("value", same_line_or_with_block($, $.expression)),
    ),

    // Function expression: fn params: body
    // Space-separated parameters for consistency with space-application syntax
    // Body supports same-line or natural indentation (no 'with' keyword required)
    lambda_expression: $ => seq(
      $.kw_fn,
      repeat1(field("param", $.identifier)),
      $.colon,
      field("body", choice(
        $.expression,
        seq(
          $.newline,
          $.indent,
          withLeadingNewlines($, $.expression),
          repeat($.newline),
          $.dedent,
        ),
      )),
    ),

    if_expression: $ => seq(
      $.kw_if,
      field("condition", $.expression),
      $.kw_then,
      field("then_value", $.expression),
      $.kw_else,
      field("else_value", $.expression),
    ),

type_expression: $ => prec.right(choice(
      seq($.type_non_function, $.arrow_op, same_line_or_with_block($, $.type_expression)),
      $.type_non_function,  // atom or tuple (for multi-arg: use (A, B) -> C syntax)
    )),

    constraint_clause: $ => seq(
      $.kw_where,
      field("type_var", $.identifier),
      $.colon,
      field("constraint", $.type_non_function),
    ),

    type_non_function: $ => choice(
      $.type_atom,
      $.type_tuple,
      $.type_record,
      $.type_tag_union,
      $.type_application,
    ),

    type_application: $ => prec.left(1, seq(
      field("head", choice($.type_application, $.type_atom)),
      field("arg", $.type_arg),
    )),

    type_arg: $ => choice(
      $.identifier,           // type variables: a, b, c
      $.tag_name,             // concrete types: U8, String, List
      alias("_", $.type_wildcard),
    ),

    type_atom: $ => choice(
      $.type_name,
      alias("_", $.type_wildcard),
      alias("*", $.type_star),
      $.parenthesized_type,
    ),

    type_name: $ => seq($.name, repeat(seq(token.immediate("."), $.name)), optional($.type_args)),
    // Type arguments use first/rest field pattern for consistency with call and tuple lists
    type_args: $ => seq(
      token.immediate("("),
      optional(seq(
        field("first", $.type_expression),
        field("rest", repeat(seq(repeat($.newline), $.comma, repeat($.newline), $.type_expression))),
        optional(seq(repeat($.newline), $.comma)),
      )),
      $.rparen,
    ),

    type_field: $ => seq($.identifier, ":", same_line_or_with_block($, $.type_expression)),

    type_tag_union: $ => layoutBracket($, $.lbracket, $.rbracket, $.tag_type),

    tag_type: $ => seq($.tag_name, optional(seq($.lparen, commaSep1Trail($, $.type_expression, $.comma, $.newline), $.rparen))),

    type_tuple: $ => tuple_like($, $.type_expression),

    parenthesized_type: $ => seq($.lparen, $.type_expression, $.rparen),

    literal: $ => choice(
      $.int_literal,
      $.float_literal,
      $.string,
      $.multiline_string,
      alias("true", $.bool_literal),
      alias("false", $.bool_literal),
    ),

    float_literal: $ => token(choice(
      /[0-9][0-9_]*\.[0-9][0-9_]*(?:[eE][+-]?[0-9_]+)?(?:f32|f64)?/,
      /[0-9][0-9_]*\.(?:[eE][+-]?[0-9_]+)?(?:f32|f64)?/,
      /\.[0-9][0-9_]*(?:[eE][+-]?[0-9_]+)?(?:f32|f64)?/,
      /[0-9][0-9_]*[eE][+-]?[0-9_]+(?:f32|f64)?/,
    )),

    int_literal: $ => token(choice(
      /0[bB][01][01_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?/,
      /0[oO][0-7][0-7_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?/,
      /0[xX][0-9a-fA-F][0-9a-fA-F_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?/,
      /[0-9][0-9_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?/,
    )),

    string: $ => seq(
      '"',
      repeat(choice(
        $.string_text,
        $.escape_sequence,
        $.interpolation,
      )),
      '"',
    ),

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

    interpolation: $ => seq(
      $.interpolation_start,
      $.expression,
      ")",
    ),

    interpolation_start: $ => token(/\\\(/),

    string_text: $ => token(/[^"\\\n]+/),

    // Multiline string content tokens: guaranteed safe because:
    // - multiline_text: /[^\\"]+/ cannot match any quote chars, so it stops before " sequences
    // - multiline_quote: /"[^"]/ matches " + non-", so never matches "" or """
    // - multiline_double_quote: /""[^"]/ matches "" + non-", so never matches """
    // This design ensures: any quote sequence of 3+ is preserved as the closing """ delimiter
    multiline_text: $ => token(/[^\\"]+/),
    multiline_quote: $ => token(/"[^"]/),
    multiline_double_quote: $ => token(/""[^"]/),

    escape_sequence: $ => token(/\\(u\([0-9A-Fa-f]{1,8}\)|[\\'"ntrbfv])/),

    doc_comment: $ => token(prec(-1, /##[^\n]*/)),
    line_comment: $ => token(prec(-2, /#[^\n]*/)),

    block_comment: $ => token(prec(-3,
      seq(
        "<#",
        repeat(choice(
          /[^#]/,
          /#[^>]/,
        )),
        "#>",
      ),
    )),

    name: $ => choice($.identifier, $.tag_name),

    identifier: $ => token(prec(1, /(_*[a-z][a-zA-Z0-9_]*!?)/)),
    tag_name: $ => token(/(_*[A-Z][a-zA-Z0-9_]*)/),

    long_identifier: $ => prec.left(seq($.name, repeat(seq(token.immediate("."), $.name)))),

    placeholder: $ => token("__"),

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
    kw_fn: $ => token(prec(2, "fn")),
    kw_or: $ => token(prec(2, "or")),
    kw_and: $ => token(prec(2, "and")),
    kw_not: $ => token(prec(2, "not")),
    kw_as: $ => token(prec(2, "as")),

    lparen: $ => "(",
    rparen: $ => ")",
    lbracket: $ => "[",
    rbracket: $ => "]",
    lbrace: $ => "{",
    rbrace: $ => "}",
    comma: $ => ",",
    colon: $ => ":",
    equals: $ => token(prec(2, "=")),
    dot: $ => ".",
    // Pipe operator with explicit tokenization priority to avoid conflicts
    // |> must match before | to prevent partial tokenization
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
    // Comparison operators: longer tokens get higher precedence to prevent ambiguity
    // E.g., "<=" must match before "<", ">=" must match before ">"
    eq_op: $ => token(prec(3, "==")),
    ne_op: $ => token(prec(3, "!=")),
    le_op: $ => token(prec(4, "<=")),
    ge_op: $ => token(prec(4, ">=")),
    lt_op: $ => token(prec(3, "<")),
    gt_op: $ => token(prec(3, ">")),
    arrow_op: $ => "->",
    try_op: $ => "?",

    type_record: $ => layoutBracket($, "{", "}", $.type_field),

    type_wildcard: $ => "_",
    type_star: $ => "*",
  },
});


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

// Helper: apply leading newlines to a rule (without creating a conflicting nonterminal)
function withLeadingNewlines($, rule) {
  return seq(repeat($.newline), rule);
}

// Helper: with-block form only (with keyword followed by newline, indent, and rule)
function with_block($, rule) {
  return seq($.kw_with, $.newline, $.indent, withLeadingNewlines($, rule), repeat($.newline), $.dedent);
}

// Helper: indented block (newline + indent + rule), without requiring `with` keyword
// Strict: requires exactly one newline (no blank lines) between = and indented expression
function indent_block($, rule) {
  return seq($.newline, $.indent, withLeadingNewlines($, rule), repeat($.newline), $.dedent);
}

// Helper: same-line form OR indented-block form (choice between them)
// For let-value bodies: allows `let x = expr` OR `let x =\n  expr` (no `with` needed)
function same_line_or_indent_block($, rule) {
  return choice(
    rule,  // same line: name = expr
    indent_block($, rule),  // next line: name =\n  expr
  );
}

// Helper: same-line form OR with-block form (choice between them)
function same_line_or_with_block($, rule) {
  return choice(
    rule,  // same line: name = expr
    with_block($, rule),  // next line: name = with \n  expr
  );
}

// Helper: comma-separated list items with optional newlines (for use in arg_list, tuple_list, etc.)
// Policy: first item consumes leading newlines; rest items consume leading newlines before commas
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

// Helper: tuple or type-tuple - single-line or multi-line with proper newline/comma/field handling
// Field naming convention for list-like structures (tuples, calls, type-args):
// - Uses field("first", ...) for the initial element
// - Uses field("rest", ...) for remaining elements as a sequence
// This provides consistent structure for downstream tools processing list-like expressions
function tuple_like($, itemRule) {
  return choice(
    // Single-line: (item, item, ...)
    seq(
      $.lparen,
      field("first", itemRule),
      $.comma,
      field("rest", commaSep1Trail($, itemRule, $.comma, $.newline)),
      $.rparen,
    ),
    // Multi-line: (\n<indent>item,\nitem,\n...<dedent>)
    // Policy: each item consumes its own leading newlines
    seq(
      $.lparen,
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
      $.dedent,
      $.rparen,
    ),
  );
}

// Helper: function argument list - single-line or multi-line with proper newline/comma handling
// Uses same first/rest field structure as tuple_like for consistency across list-like expressions
// IMPORTANT: Uses token.immediate("(") to require NO WHITESPACE before (
// This disambiguates f(x) [call] from f (x) [space-application]
function arg_list($, itemRule) {
  return choice(
    // Single-line: (arg, arg, ...)
    seq(
      token.immediate("("),
      optional(seq(
        field("first", itemRule),
        field("rest", repeat(seq(repeat($.newline), $.comma, repeat($.newline), itemRule))),
        optional(seq(repeat($.newline), $.comma)),
      )),
      $.rparen,
    ),
    // Multi-line: (\n<indent>arg,\narg,\n...<dedent>)
    seq(
      token.immediate("("),
      repeat1($.newline),
      $.indent,
      optional(seq(
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
      )),
      $.dedent,
      $.rparen,
    ),
  );
}

function multiLineBracket($, open, commaToken, item, close) {
  return seq(
    open,
    $.newline,

    $.indent,
    commaSep1Trail($, item, commaToken, $.newline),
    $.dedent,
    close,
  );
}

function layoutBracket($, open, close, item) {
  return choice(
    singleLineBracket(open, $.comma, item, close),
    multiLineBracket($, open, $.comma, item, close),
  );
}

function commaSepTrail($, rule, commaToken, sepToken) {
  return optional(commaSep1Trail($, rule, commaToken, sepToken));
}

function commaSep1Trail($, rule, commaToken, sepToken) {
  return seq(
    rule,
    repeat(seq(repeat(sepToken), commaToken, repeat(sepToken), rule)),
    optional(seq(repeat(sepToken), commaToken)),
  );
}

// Record expression helpers: support { field: val }, { field: val, ..base }, or { ..base }
function singleLineRecordExpression($, field) {
  return seq(
    $.lbrace,
    optional(choice(
      // Fields with optional spread
      seq(
        field,
        repeat(seq($.comma, field)),
        optional(seq($.comma, "..", $.expression))
      ),
      // Pure spread (no fields)
      seq("..", $.expression)
    )),
    $.rbrace,
  );
}

function multiLineRecordExpression($, field) {
  return seq(
    $.lbrace,
    $.newline,
    $.indent,
    optional(choice(
      // Fields with optional spread
      seq(
        field,
        repeat(seq(optional($.newline), $.comma, optional($.newline), field)),
        optional(seq(optional($.newline), $.comma, optional($.newline), "..", $.expression))
      ),
      // Pure spread (no fields)
      seq("..", $.expression)
    )),
    $.dedent,
    $.rbrace,
  );
}
