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
//
// Keywords and punctuation are anonymous, so `named_children` is semantic.

// Always keywords. The rest (record, choice, shape, alias, distinct, tag,
// intrinsic, type, test, expect, use, derive) are contextual: names everywhere
// except where a declaration or statement can start with them. The resolver
// rejects them as top-level declaration names.
const RESERVED = [
  "pub", "rec", "mut", "if", "then", "else", "case", "where", "module", "fn",
  "or", "and", "not", "mod", "xor", "as", "in", "self", "Self",
];

// digit runs may contain underscores but not start or end with one
const digits = (c) => `${c}(?:[${c.slice(1, -1)}_]*${c})?`;
const DEC = digits("[0-9]");
const HEX = digits("[0-9a-fA-F]");
const OCT = digits("[0-7]");
const BIN = digits("[01]");
const INT_SUFFIX = "(?:U8|U16|U32|U64|I8|I16|I32|I64)?";
const FLOAT_SUFFIX = "(?:F32|F64)";
const EXPONENT = `(?:[eE][+-]?${DEC})`;
// 1.5 only: no `1.` (swallows the dot of `1..<n`), no `.5`
const DEC_POINT = `${DEC}\\.${DEC}`;
const ESCAPE_BODY = // \u(1F600) is the only unicode form
  `(?:[ntrbfv0'"\\\\]|x[0-9A-Fa-f]{2}|u\\([0-9A-Fa-f]{1,8}\\))`;

// --- helpers -----------------------------------------------------------------
const sep1 = (rule, sep = ",") => seq(rule, repeat(seq(sep, rule)));
// trailing separator allowed
const separated1 = (rule, sep = ",") => seq(sep1(rule, sep), optional(sep));
const collection = (open, close, item) =>
  seq(open, optional(separated1(item)), close);
const braced = (item) => collection("{", "}", item);

const binary = (lhs, op, rhs) =>
  seq(field("lhs", lhs), field("op", op), field("rhs", rhs));

// 2+ items. `(a)` is parenthesized, `(a,)` is invalid, there is no 1-tuple.
const tuple = (item) =>
  seq(
    "(",
    field("element", item),
    repeat1(seq(",", field("element", item))),
    optional(","),
    ")",
  );

// `[a, b, ..rest]`; rest only last
const withRest = (open, close, item, rest) =>
  seq(
    open,
    optional(choice(seq(sep1(item), optional(seq(",", rest))), rest)),
    close,
  );

module.exports = grammar({
  name: "kippy",
  word: ($) => $.identifier,
  // field names reserve nothing (`a.if`); the resolver rejects a reserved
  // word as a pun (`{ in }`), since it's a variable
  reserved: {
    global: () => [...RESERVED, "__", "_"],
    field: () => [],
  },

  extras: ($) => [/[ \t\r\n\f]+/, $.doc_comment, $.line_comment, $.block_comment],

  supertypes: ($) => [$.expression, $.type_constructor],

  // No declared conflicts. Keep it that way.

  rules: {
    // --- source structure ---
    source_file: ($) => seq(optional($.module_declaration), repeat($.module_item)),

    module_declaration: ($) => seq("module", field("name", $.path)),

    module_item: ($) =>
      seq(
        repeat(field("attribute", $.attribute)),
        choice($.use_statement, $.binding, $.derive_declaration, $.test_declaration),
      ),

    // `use foo { a, b }`; `pub use` re-exports
    use_statement: ($) =>
      seq(
        field("visibility", optional("pub")),
        "use",
        field("module", $.path),
        optional(seq("as", field("alias", $.identifier))),
        optional(field("imports", $.import_set)),
      ),
    import_set: ($) => braced($.import_item),
    import_item: ($) =>
      seq(
        field("name", $.identifier),
        optional(seq("as", field("alias", $.identifier))),
      ),

    // --- declarations ---
    // Values, types and shape implementations are all this one rule.
    // Brackets after the name are always type parameters; one that shadows a
    // type (`List[Int] : S`) is an error. `x : T` with no value needs #extern
    // or #lang; an all-defaults impl is `Task : S = _ {}`.
    // A type constructor takes no `where` and no `=`. Constraints go before
    // `=`, annotated or not: `max[T] where T : Ord = fn (a, b) => ...`.
    binding: ($) =>
      seq(
        field("visibility", optional("pub")),
        field("modifier", optional("rec")),
        field("name", $.identifier),
        optional(field("type_params", $.type_parameter_list)),
        choice(
          seq(":", field("constructor", $.type_constructor)),
          seq(
            ":",
            field("type", $.type_expression),
            optional(field("constraints", $.constraint_clause)),
            optional(seq("=", field("value", $.expression))),
          ),
          seq(
            optional(field("constraints", $.constraint_clause)),
            "=",
            field("value", $.expression),
          ),
        ),
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
    alias_constructor: ($) => seq("alias", field("body", $.type_expression)),

    // always wraps: UserId : distinct Int. Payload-less marker? use tag.
    distinct_constructor: ($) => seq("distinct", field("body", $.type_expression)),

    tag_constructor: () => "tag",

    // compiler supplies the representation; pairs with a #lang(...) attr
    intrinsic_constructor: () => "intrinsic",

    // The only places record_type appears: here and as a choice variant
    // payload. Both are named, so there are no anonymous record types.
    record_constructor: ($) => seq("record", field("body", $.record_type)),

    choice_constructor: ($) =>
      seq("choice", field("body", braced($.choice_variant))),

    // Impls are keyed by Self plus the shape's parameters, so a type can
    // implement Mul[F32] and Mul[Vec2]. Associated types are decided by that
    // key: one impl per key, so each key has exactly one Output.
    shape_constructor: ($) =>
      seq(
        "shape",
        optional(seq(":", field("parents", $.constraint_sum))),
        field("members", braced(choice($.shape_method, $.associated_type))),
      ),

    choice_variant: ($) =>
      seq(
        repeat(field("attribute", $.attribute)),
        field("name", $.identifier),
        optional(choice(
          seq("(", separated1(field("payload", $.type_expression)), ")"),
          field("payload", $.record_type),
        )),
      ),

    type_parameter_list: ($) => seq("[", separated1($.identifier), "]"),

    // --- shapes ---
    // collapse[A] : fn(Self, A, fn(A, T) -> A) -> A where A : Eq = ...
    shape_method: ($) =>
      seq(
        repeat(field("attribute", $.attribute)),
        field("name", $.identifier),
        optional(field("type_params", $.type_parameter_list)),
        ":",
        field("type_ann", $.type_expression),
        optional(field("constraints", $.constraint_clause)),
        optional(seq("=", field("default", $.expression))),
      ),

    // type Output   type Item : Eq   type Output = Self
    // Bound in an impl header: `Vec2 : Mul[F32, Output = Vec2] = _ { ... }`.
    associated_type: ($) =>
      seq(
        repeat(field("attribute", $.attribute)),
        "type",
        field("name", $.identifier),
        optional(seq(":", field("bounds", $.constraint_sum))),
        optional(seq("=", field("default", $.type_expression))),
      ),

    // derive UserId : Eq + Ord + Hash
    derive_declaration: ($) =>
      seq(
        "derive",
        optional(field("type_params", $.type_parameter_list)),
        field("type", $._concrete_type_head),
        ":",
        field("shape", $.constraint_sum),
        optional(field("constraints", $.constraint_clause)),
      ),

    // --- attributes ---
    // #opaque pub T : ... exports T but not its constructor or fields;
    // #opaque without pub is an error. Unknown attributes are errors.
    attribute: ($) =>
      seq(
        "#",
        field("path", $.path),
        optional(field("args", $.attribute_arguments)),
      ),
    attribute_arguments: ($) => collection("(", ")", $.attribute_argument),
    attribute_argument: ($) =>
      choice(
        $._attribute_value,
        seq(field("name", $.identifier), "=", field("value", $._attribute_value)),
      ),
    // compile-time metadata, not typed values, so records stay anonymous
    _attribute_value: ($) =>
      choice(
        $.negative_literal,
        $.percent_literal,
        $.int_literal,
        $.float_literal,
        $.char_literal,
        $.static_text,
        $.raw_text,
        $.path,
        $.attribute_list,
        $.attribute_record,
        seq("(", $._attribute_value, ")"),
      ),
    attribute_list: ($) => collection("[", "]", $._attribute_value),
    attribute_record: ($) => braced($.attribute_record_field),
    attribute_record_field: ($) =>
      seq(field("name", $.field_name), "=", field("value", $._attribute_value)),

    // --- tests ---
    test_declaration: ($) =>
      seq("test", field("name", $.static_text), field("body", $.test_body)),
    // like a block, minus the result
    test_body: ($) => seq("{", repeat(seq($._statement, ";")), "}"),
    // any statement position; resolver rejects it outside tests
    expect_statement: ($) => seq("expect", field("value", $.expression)),

    field_name: ($) => reserved("field", $.identifier),

    // --- expressions ---
    expression: ($) => choice($.lambda_expression, $.if_expression, $._pipe_level),

    // postfix at pipe level: `xs |> f(__) case { ... } |> g(__)`. Operator
    // subjects need parens: `(total + bonus) case { ... }`.
    case_expression: ($) =>
      seq(
        field("subject", choice(
          alias($.pipe_binary, $.binary_expression),
          $.case_expression,
          $._postfix_level,
        )),
        "case",
        field("body", braced($.match_arm)),
      ),

    // `..base` in lists and record bodies. A bare `..` is only accepted by the
    // resolver in a binding target: `User { name, .. } = user`.
    spread_element: ($) => seq("..", optional(field("base", $.expression))),

    // --- operator ladder (loosest to tightest) ---
    // Hidden levels; a node only appears when its operator does.
    _pipe_level: ($) =>
      choice(
        alias($.pipe_binary, $.binary_expression),
        $.case_expression,
        $._or_level,
      ),
    pipe_binary: ($) => binary($._pipe_level, "|>", $._or_level),

    _or_level: ($) => choice(alias($.or_binary, $.binary_expression), $._and_level),
    or_binary: ($) => binary($._or_level, "or", $._and_level),

    _and_level: ($) =>
      choice(alias($.and_binary, $.binary_expression), $._compare_level),
    and_binary: ($) => binary($._and_level, "and", $._compare_level),

    // non-associative: `a < b < c` doesn't parse
    _compare_level: ($) =>
      choice(alias($.compare_binary, $.binary_expression), $._range_level),
    compare_binary: ($) =>
      binary(
        $._range_level,
        choice("==", "!=", "<", ">", "<=", ">="),
        $._range_level,
      ),

    // `a..<b` excludes b, `a..=b` includes it. Non-associative, both ends
    // required, integers or Char. Value is the prelude's Range[T] record.
    _range_level: ($) => choice($.range_expression, $._bit_level),
    range_expression: ($) =>
      binary($._bit_level, choice("..<", "..="), $._bit_level),

    // & | xor << >>, tighter than comparison: `a & m == 0` is `(a & m) == 0`.
    // Mixing different bit operators needs parens (resolver).
    _bit_level: ($) => choice(alias($.bit_binary, $.binary_expression), $._add_level),
    bit_binary: ($) =>
      binary($._bit_level, choice("&", "|", "xor", "<<", ">>"), $._add_level),

    _add_level: ($) => choice(alias($.add_binary, $.binary_expression), $._mul_level),
    add_binary: ($) => binary($._add_level, choice("+", "-"), $._mul_level),

    _mul_level: ($) =>
      choice(alias($.mul_binary, $.binary_expression), $._unary_level),
    mul_binary: ($) => binary($._mul_level, choice("*", "/", "mod"), $._unary_level),

    // `not` binds tightly, same as `-`. `not a == b` is `(not a) == b`.
    _unary_level: ($) => choice($.unary_expression, $._postfix_level),
    unary_expression: ($) =>
      seq(field("op", choice("-", "not", "~")), field("operand", $._unary_level)),

    // --- postfix chain ---
    _postfix_level: ($) => choice($.postfix_expression, $._primary),
    postfix_expression: ($) =>
      prec.left(
        seq(
          field("base", $._primary),
          repeat1(choice(
            $.record_body,
            $.call_suffix,
            $.index_suffix,
            $.field_suffix,
            $.tuple_index_suffix,
            $.try_suffix,
            $.method_suffix,
          )),
        ),
      ),

    call_suffix: ($) => seq("(", optional(separated1(field("arg", $.expression))), ")"),
    // type application if the base has type parameters (`id[Int](x)`, one
    // arg each), otherwise indexing (`xs[i]`, one arg). Resolver decides.
    // Function and variadic types can't be written here; alias them first:
    // `IntFn : alias fn(Int) -> Int`, then `id[IntFn](f)`.
    index_suffix: ($) => seq("[", separated1(field("index", $.expression)), "]"),
    field_suffix: ($) => seq(".", field("field", $.field_name)),

    // `t.0.1`: float_literal isn't valid after `.`
    tuple_index_suffix: ($) => seq(".", field("index", $.tuple_index)),
    tuple_index: () => token.immediate(/0|[1-9][0-9]*/),

    try_suffix: () => "?",

    // @ finds the implementation by type; @Shape::method disambiguates a
    // method name declared by two different shapes.
    method_suffix: ($) => seq("@", field("method", $.path)),

    // --- primary ---
    _primary: ($) =>
      choice(
        $.block_expression,
        $._literal,
        $.path,
        $.placeholder,
        $.pipe_hole,
        $.wildcard, // binding target or `_ { ... }` only
        $.unit,
        $.list_expression,
        $.map_expression,
        $.tuple_expression,
        $.parenthesized_expression,
      ),

    unit: () => seq("(", ")"),

    list_expression: ($) => collection("[", "]", choice($.expression, $.spread_element)),
    map_expression: ($) => collection("#[", "]", $.map_entry),
    map_entry: ($) =>
      seq(field("key", $.expression), "=>", field("value", $.expression)),

    tuple_expression: ($) => tuple($.expression),
    parenthesized_expression: ($) => seq("(", field("value", $.expression), ")"),

    // Suffix only; a bare `{` is a block. Type base: construction. `_` base:
    // construction of the expected type, e.g. `Task : Display = _ { show = ... }`.
    // Value base: functional update.
    record_body: ($) => braced($.record_field),
    record_field: ($) =>
      choice(
        seq(field("name", $.field_name), "=", field("value", $.expression)),
        field("name", $.field_name), // pun: `{ x }` == `{ x = x }`
        $.spread_element,
      ),

    // --- control flow ---

    block_expression: ($) =>
      seq(
        "{",
        repeat(seq($._statement, ";")),
        optional(field("result", $.expression)),
        "}",
      ),

    // x = 10;  mut total : Int = 0;  (a, b) = pair;  User { name, .. } = u;
    // Cover grammar: the target parses as an expression; the resolver checks
    // it's an irrefutable pattern. Targeted errors: `x.y = e` / `xs[i] = e`
    // ("did you mean `^x.y`"), `{ x } = p` ("name the record type").
    // `mut`: the name takes successive values, not shared mutable storage.
    local_binding: ($) =>
      seq(
        field("modifier", optional(choice("rec", "mut"))),
        field("target", $._postfix_level),
        optional(seq(":", field("type_ann", $.type_expression))),
        "=",
        field("value", $.expression),
      ),

    // ^total = total + x;  ^state.tick += 1;  ^xs[i] = v;
    // No expression starts with `^`, so the first token decides.
    update_statement: ($) =>
      seq(
        "^",
        field("target", $._postfix_level),
        field("op", choice("=", "+=", "-=", "*=", "/=", "&=", "|=", "<<=", ">>=")),
        field("value", $.expression),
      ),

    _statement: ($) =>
      choice(
        $.local_binding,
        $.update_statement,
        $.loop_statement,
        $.expect_statement,
        $.expression,
      ),

    // x in xs => body;  (k, v) in pairs => ...;  same cover as local_binding
    loop_statement: ($) =>
      seq(
        field("pattern", $._postfix_level),
        "in",
        field("iterable", $.expression),
        "=>",
        field("body", $._statement),
      ),

    // no `else`: then-branch must be `()`
    if_expression: ($) =>
      prec.right(seq(
        "if",
        field("condition", $._pipe_level),
        "then",
        field("then_value", $.expression),
        optional(seq("else", field("else_value", $.expression))),
      )),

    // `else =>` is not `_ =>`: the totality checker treats else as deliberate
    // incompleteness and names the variants it swallows. A guard belongs to
    // the whole arm.
    match_arm: ($) =>
      seq(
        choice(
          seq(
            field("pattern", $._pattern),
            optional(seq("if", field("guard", $.expression))),
          ),
          "else",
        ),
        "=>",
        field("value", $.expression),
      ),

    // fn (a: Int, b: Int) -> Int => a + b; both annotations optional.
    // Parameter patterns must be irrefutable (resolver).
    lambda_parameter: ($) =>
      seq(
        field("pattern", $._pattern),
        optional(seq(":", field("type_ann", $.type_expression))),
      ),
    lambda_parameters: ($) => collection("(", ")", field("param", $.lambda_parameter)),
    lambda_expression: ($) =>
      prec.right(seq(
        "fn",
        field("params", $.lambda_parameters),
        optional(seq(
          field("arrow", choice("->", "->!")),
          field("return_type", $.type_expression),
        )),
        "=>",
        field("body", $.expression),
      )),

    // --- patterns ---
    // Hidden levels, like the operator ladder.
    _pattern: ($) => choice($.or_pattern, $._as_level),
    _as_level: ($) => choice($.as_pattern, $._atomic_pattern),
    or_pattern: ($) =>
      seq(field("alternative", $._as_level), repeat1(seq("|", field("alternative", $._as_level)))),
    as_pattern: ($) =>
      seq(field("pattern", $._atomic_pattern), "as", field("binding", $.identifier)),

    _atomic_pattern: ($) =>
      choice(
        $.range_pattern,
        $._pattern_literal,
        $.negative_literal,
        $.unit,
        $.wildcard,
        $.path_pattern,
        $.list_pattern,
        $.tuple_pattern,
        $.record_pattern,
        $.parenthesized_pattern,
      ),

    // Some(x)  Move { dx, dy }  User { name, .. }  x
    path_pattern: ($) =>
      seq(
        field("constructor", $.path),
        optional(choice(
          seq(
            "(",
            choice(
              seq(
                sep1(field("payload", $._pattern)),
                optional(seq(",", $.rest_pattern)),
              ),
              $.rest_pattern,
            ),
            ")",
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
        $.raw_text,
      ),

    // -1  -0.5  -10%
    negative_literal: ($) =>
      seq("-", field("value", choice($.int_literal, $.float_literal, $.percent_literal))),

    // 'a'..='z'  0..<10  -5..=5
    range_pattern: ($) =>
      seq(
        field("start", $._range_bound),
        field("op", choice("..<", "..=")),
        field("end", $._range_bound),
      ),
    _range_bound: ($) => choice($.int_literal, $.negative_literal, $.char_literal),

    list_pattern: ($) => withRest("[", "]", $._pattern, $.rest_pattern),
    tuple_pattern: ($) => tuple($._pattern),
    parenthesized_pattern: ($) => seq("(", field("value", $._pattern), ")"),
    // nameless: type from the scrutinee; not against a choice
    record_pattern: ($) => withRest("{", "}", $.record_pattern_field, ".."),
    // `name = pattern` or punned `name`
    record_pattern_field: ($) =>
      choice(
        seq(field("name", $.field_name), "=", field("value", $._pattern)),
        field("name", $.field_name),
      ),
    // `..rest` or bare `..`, last only
    rest_pattern: ($) => seq("..", optional(field("binding", $.identifier))),

    // --- types ---
    // `T::Output` is a plain path; the resolver makes it a projection when the
    // head is a type parameter. Use projection_type when T has several impls
    // of the shape.
    type_expression: ($) =>
      choice($.function_type, $.wildcard, $.projection_type, $._concrete_type_head),

    // T@Mul::Output (last segment is the member, like `x@Shape::method`) or,
    // with shape arguments, T@Mul[F32]::Output
    projection_type: ($) =>
      seq(
        field("self", $.path_or_applied),
        "@",
        field("shape", $.path),
        optional(seq(
          field("args", $.type_argument_list),
          token.immediate("::"),
          field("name", $.identifier),
        )),
      ),
    // `...T`: function parameters and type arguments only
    variadic_type: ($) => seq("...", field("item", $.type_expression)),

    // no record_type here: records are nominal
    _concrete_type_head: ($) =>
      choice($.path_or_applied, $.unit, $.tuple_type, $.parenthesized_type),

    path_or_applied: ($) =>
      seq(
        field("constructor", $.path),
        optional(field("args", $.type_argument_list)),
      ),
    type_argument_list: ($) =>
      seq(
        "[",
        separated1(choice($.type_expression, $.variadic_type, $.associated_type_binding)),
        "]",
      ),
    // `Output = T`: binds an associated type in an impl header or constraint
    associated_type_binding: ($) =>
      seq(field("name", $.identifier), "=", field("type", $.type_expression)),

    // -> and ->! stay distinct tokens so the effect checker sees which was
    // written. Bare -> on a higher-order type is effect-polymorphic. The
    // arrow is required: `fn(Text) ->! ()`, never `fn(Text)`.
    function_type: ($) =>
      seq(
        "fn",
        collection("(", ")", field("param", choice($.type_expression, $.variadic_type))),
        field("arrow", choice("->", "->!")),
        field("result", $.type_expression),
      ),

    record_type: ($) => braced($.record_type_field),
    record_type_field: ($) =>
      seq(
        repeat(field("attribute", $.attribute)),
        field("name", $.field_name),
        ":",
        field("type_ann", $.type_expression),
      ),
    tuple_type: ($) => tuple($.type_expression),
    parenthesized_type: ($) => seq("(", field("value", $.type_expression), ")"),

    // --- constraints ---
    constraint_clause: ($) =>
      seq("where", choice($.constraint_entry, collection("(", ")", $.constraint_entry))),
    constraint_entry: ($) =>
      seq(field("type_var", $.identifier), ":", field("constraint", $.constraint_sum)),
    // T : Eq + Into[Int]. Also derive and shape parents.
    constraint_sum: ($) =>
      prec.left(sep1(field("shape", $.path_or_applied), "+")),

    // --- literals ---
    _literal: ($) =>
      choice(
        $.percent_literal,
        $.int_literal,
        $.float_literal,
        $.char_literal,
        $.text,
        $.multiline_text,
        $.raw_text,
      ),

    // percent before float before int: 1.5% / 1.5 / 1 share a prefix, so the
    // order of these three rules matters. Order inside each does not.
    percent_literal: () =>
      token(new RustRegex(`(?:${DEC_POINT}|${DEC})${EXPONENT}?%`)),
    float_literal: () =>
      token(
        new RustRegex(
          // no point? then an exponent or suffix is required: 1e9, 1F32
          `(?:(?:${DEC_POINT}${EXPONENT}?|${DEC}${EXPONENT})${FLOAT_SUFFIX}?|${DEC}${FLOAT_SUFFIX})`,
        ),
      ),
    int_literal: () =>
      token(new RustRegex(`(?:0[bB]${BIN}|0[oO]${OCT}|0[xX]${HEX}|${DEC})${INT_SUFFIX}`)),

    char_literal: () => token(new RustRegex(`'(?:[^'\\\\\\r\\n]|\\\\${ESCAPE_BODY})'`)),

    // static_text is text minus interpolation, for compile-time constants.
    // Immediate tokens after the opening quote: no comments or newlines inside.
    text: ($) =>
      seq(
        '"',
        repeat(choice($.text_content, $.escape_sequence, $.interpolation)),
        token.immediate('"'),
      ),
    text_content: () => token.immediate(prec(2, /[^"\\\r\n]+/)),
    static_text: ($) =>
      seq(
        '"',
        repeat(choice(alias($.text_content, $.static_text_content), $.escape_sequence)),
        token.immediate('"'),
      ),
    // `"""` ends its line; the closing `"""` starts its own (resolver), so
    // content may end in `"`. The resolver strips the closing indentation.
    multiline_text: ($) =>
      seq(
        alias(/"""[ \t]*/, '"""'),
        optional(seq(
          $._multiline_newline,
          repeat(choice(
            $.multiline_content,
            $._multiline_newline,
            $.escape_sequence,
            $.interpolation,
          )),
        )),
        token.immediate('"""'),
      ),
    _multiline_newline: () => token.immediate(/\r?\n[ \t]*/),
    multiline_content: () =>
      choice(token.immediate(prec(2, /[^"\\\r\n]+/)), token.immediate(/""?/)),
    // #"C:\dir\file"# — no escapes or interpolation; can't contain `"#`
    raw_text: () => token(/#"(?:[^"]|"+[^"#])*"+#/),
    interpolation: ($) => seq(token.immediate("\\("), field("value", $.expression), ")"),
    escape_sequence: () => token.immediate(new RustRegex(`\\\\${ESCAPE_BODY}`)),

    // --- comments ---
    // NON-NESTING: `/* a /* b */ c */` ends at the first `*/`. Nesting needs
    // an external scanner. `////` is longer as a line comment; `/// x` ties
    // and the earlier rule wins.
    doc_comment: () => token(/\/\/\/(?:[^/\n][^\n]*)?/),
    line_comment: () => token(/\/\/[^\n]*/),
    block_comment: () => token(seq("/*", /[^*]*\*+([^/*][^*]*\*+)*/, "/")),

    // --- identifiers, paths, holes ---
    identifier: () => token(new RustRegex("[_\\p{ID_Start}][\\p{ID_Continue}]*")),
    // `self` is the current module only (a bare `self` pattern or value is a
    // resolver error); `Self` works in types and values
    path: ($) =>
      seq(
        field("head", choice(
          $.identifier,
          alias("self", $.self),
          alias("Self", $.self_type),
        )),
        repeat(seq(token.immediate("::"), field("segment", $.identifier))),
      ),
    // one-argument lambda hole. Type-directed: its scope is the innermost
    // enclosing call argument whose expected type is a function, so
    // `map(users, show($.name))` is `map(users, fn (u) => show(u.name))` and
    // `zip(map(a, $ + 1), map(b, $ * 2))` is two lambdas. A generic expected
    // type is an error. Every `$` in one scope is the same parameter.
    placeholder: () => "$",
    // pipeline hole: `xs |> map(__, $ * 2)`. Every `|>` RHS contains exactly
    // one. Reserved, so it can't be bound.
    pipe_hole: () => "__",
    wildcard: () => "_",
  },
});
