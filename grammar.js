// Kippy grammar (Sketch C). See notes/syntax.md for the long version.
//
// The one rule that makes everything else fall out:
//   top-level decl = [pub] name [generics] [: type] [= value]
// What kind of decl it is depends on the RHS, not a leading keyword.
//   - RHS starts with record/choice/shape/distinct/alias/tag/intrinsic -> it's a type
//   - anything else -> it's a value (and may or may not have an = body)
//
// CHANGES FROM SKETCH B
//
// 1. The fit form is gone. `Task : Display { show(self) => ... }` no longer
//    parses. A shape is a record type, so an implementation is a record value:
//        Task : Display = { show = fn(t) => t.name }
//    Deleted: fit_member, fit_method, fit_type_def, method_parameter_list,
//    method_body, shape_type_decl, kw_fit, kw_type, and the middle branch of
//    binding_annotation.
//
//    Bonus: that branch was the only place a path could be followed by braces
//    in annotation position, so it was ambiguous with record_suffix until the
//    resolver knew whether the path named a shape or a type. Now `P { ... }`
//    is a record literal, always.
//
// 2. Associated types are gone with it. Use a normal type parameter:
//        Iterator : shape[Item] { next : fn(Self) -> Option[Item] }
//        TaskList : Iterator[Task] = { next = fn(l) => head(l.0) }
//    We considered a `given` marker (functional dependency) so the checker
//    could infer Item from Self. Not shipping it. It buys inference, not
//    expressiveness, and it's where GHC's error messages went bad. Add it
//    later with evidence from real code.
//
// 3. Lambdas take optional parameter types and an optional return arrow:
//        fn (a: Int, b: Int) -> Int => a + b
//    Without this there was no way to annotate an inline lambda at all, so
//    inference had to win every time. It won't.
//
// 4. Constraints may come before the body as well as after. A long body used
//    to push `where` many lines below the signature.
//
// 5. derive takes a constraint_sum, not a single path:
//        derive UserId : Eq + Ord + Hash
//
// NOT IN THE GRAMMAR, but decided:
//   - `$` is a one-argument lambda hole. Its scope is the whole RHS of the
//     binding it appears in — the `=` is the boundary. That's a resolver rule;
//     the token and `$.field` already parse via placeholder + field_suffix.
//     No `key` keyword. It was carrying a Key[A,B] type that no longer exists.
//   - Shapes are coherent: one implementation per (type, shape) pair. Nothing
//     in the syntax says so. Resolver enforces it. Document it loudly.
//   - Ordering variety comes from the key TYPE, not from picking an
//     implementation: Task::by_name = $.name, sort(tasks, Task::by_name),
//     Tree[Text, Task]. Desc[K] : distinct K flips direction.
//
// STILL UNAUDITED: `build P { f <- v }`. It has its own rules and its own
// arrow and nothing in the last redesign needed it. Same smell `key` had —
// survived because it was written, not because it was re-derived. Either
// write down what it does that `P { f = v }` can't, or delete it.
//
// Separators: comma in values/types, semicolon in blocks. Don't mix them up
// again, it cost me an afternoon.
//
// Arrows: => is "body follows", -> is the return arrow. ->! is the effectful
// one (function may cross `external`). Bare -> is pure for first-order types,
// effect-polymorphic for higher-order ones (effect comes from the fn params).

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

// `sig` is gone — `name : Type` with no body does that job now.
// `let` is gone — block expressions with braces replace let..in.
// Top-level used to be `let name = value`, now it's just `name = value`.
// `fit` was never a keyword (the form was `path + braces`); the form is gone.
// `type` is gone with associated types.
const KEYWORDS = [
  "pub",
  "rec",
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
  "to",
  "where",
  "module",
  "use",
  "build",
  "derive",
  "fn",
  "test",
  "or",
  "and",
  "not",
  "mod",
  "as",
  "self",
  "Self",
  "out",
];

// Number lexing. The [0-9][0-9_]*[0-9] dance is so a literal can't start or
// end with an underscore but can have them in the middle (1_000_000).
const DEC_DIGITS = "(?:[0-9]|[0-9][0-9_]*[0-9])";
const HEX_DIGITS = "(?:[0-9a-fA-F]|[0-9a-fA-F][0-9a-fA-F_]*[0-9a-fA-F])";
const OCT_DIGITS = "(?:[0-7]|[0-7][0-7_]*[0-7])";
const BIN_DIGITS = "(?:[01]|[01][01_]*[01])";
const INT_SUFFIX = "(?:U8|U16|U32|U64|I8|I16|I32|I64)?";
const FLOAT_SUFFIX = "(?:F32|F64)?";
const PERCENT = "%";
const EXPONENT = "(?:[eE][+-]?(?:[0-9]|[0-9][0-9_]*[0-9]))";
const ESCAPE_BODY =
  `(?:[ntrbfv0'"\\\\]|x[0-9A-Fa-f]{2}|u\\([0-9A-Fa-f]{1,8}\\)|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})`;

// --- helpers -----------------------------------------------------------------
const opt = optional;
const many = repeat;

function sep1(rule, separator) {
  return seq(rule, many(seq(separator, rule)));
}

// trailing separator allowed; optional_separator makes the separator itself
// optional between items
function separated1($, rule, separator, { optional_separator = false } = {}) {
  if (optional_separator) {
    return seq(rule, many(seq(opt(separator), rule)), opt(separator));
  }
  return seq(rule, many(seq(separator, rule)), opt(separator));
}

// 2+ items, for tuples — a 1-tuple is just a parenthesized expr
function looseSeparated2Plus($, rule, separator) {
  return seq(rule, separator, rule, many(seq(separator, rule)), opt(separator));
}

function collection($, open, close, item, separator, opts = {}) {
  return seq(open, opt(separated1($, item, separator, opts)), close);
}

function flexCollection(
  $,
  open,
  close,
  rule,
  separator,
  { optional_separator = false } = {},
) {
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

function leftAssocBinop(
  precedence,
  operandRule,
  opRule,
  { single = false } = {},
) {
  // single = non-associative (comparisons: a < b < c shouldn't parse)
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
  return flexCollection($, $.lbrace, $.rbrace, rule, separator);
}
function bracedSemiBlock($, rule) {
  return bracedCollection($, rule, $.semicolon);
}

function parenPayloadList($, payloadRule) {
  return seq(
    $.lparen,
    separated1($, field("payload", payloadRule), $.comma),
    $.rparen,
  );
}

function tuple($, item, separator) {
  return seq(
    $.lparen_hash,
    looseSeparated2Plus($, field("element", item), separator),
    $.rparen,
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

  // type_constructor is a real supertype instead of an inlined choice, so it
  // shows up in node-types.json and the resolver can branch on a stable node
  // kind rather than sniffing raw keyword children.
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
    source_file: ($) => fileBody($, $.module_declaration, $.module_item),

    module_declaration: ($) => seq($.kw_module, field("name", $.path)),

    module_item: ($) => withAttributes($, $._top_level_item),
    _top_level_item: ($) => choice($.use_statement, $.declaration),

    use_statement: ($) =>
      seq(
        $.kw_use,
        field("module", $.path),
        opt(seq($.kw_as, field("alias", $.identifier))),
        opt(field("imports", $.import_set)), // `use foo { a, b }` — no dot before the brace
      ),
    import_set: ($) =>
      seq($.lbrace, opt(separated1($, $.import_item, $.comma)), $.rbrace),
    import_item: ($) =>
      seq(
        field("name", $.identifier),
        opt(seq($.kw_as, field("alias", $.identifier))),
      ),

    // --- declarations ---
    // derive/test stay keyword-led — they're actions, not "here is a named thing".
    declaration: ($) =>
      seq(field("visibility", opt($.kw_pub)), $._declaration_inner),

    _declaration_inner: ($) =>
      choice(
        $.binding,
        $.derive_declaration,
        $.test_declaration,
      ),

    // The one unified binding rule. Covers values, types, and now shape
    // implementations too — `Task : Display = { show = ... }` is just a
    // binding whose annotation is a path and whose value is a record.
    //
    // Constraints can sit before the body or after it. Both are the same
    // field; the resolver should reject a binding that uses both.
    binding: ($) =>
      seq(
        opt($.kw_rec),
        field("name", $.binding_name),
        optTypeParams($),
        choice(
          seq( // name : annotation [where ...] [= value]
            $.colon,
            field("annotation", $.binding_annotation),
            opt(field("constraints", $.constraint_clause)),
            opt(seq($.equals, $.value_slot)),
          ),
          seq($.equals, $.value_slot), // name = value
        ),
        opt(field("constraints", $.constraint_clause)),
      ),

    // Two branches now, not three. The fit branch (path + member block) is
    // gone — see the header note.
    binding_annotation: ($) =>
      choice(
        field("constructor", $.type_constructor),
        field("type", $.type_expression),
      ),

    // Real supertype (see `supertypes` above), so it gets a node-types.json
    // entry and the seven constructors are reachable as a discriminated union.
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

    // distinct always wraps something: UserId : distinct Int.
    // payload-less marker? use tag instead.
    // This is also how Desc[K] works — the one wrapper the ordering design
    // still needs, and it wraps a key, not an element.
    distinct_constructor: ($) =>
      seq($.kw_distinct, field("body", $.type_expression)),

    // bare marker, no body — atoms / phantoms / unit-likes
    tag_constructor: ($) => $.kw_tag,

    // intrinsic = compiler supplies the representation. Goes with a #lang(...)
    // attr. For the primitives we can't write in Kippy (I8, F64, Text, List).
    intrinsic_constructor: ($) => $.kw_intrinsic,

    record_constructor: ($) => seq($.kw_record, field("body", $.record_type)),

    choice_constructor: ($) =>
      seq($.kw_choice, field("body", bracedSemiBlock($, $.choice_variant))),

    // A shape is a record type of operations. Members are `name : Type` with
    // an optional default body. No `type` members any more — put the varying
    // type in the parameter list: shape[Item] { ... }.
    //
    // House rule, not a grammar rule: one required member, everything else a
    // default. That's what keeps implementations to one line.
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
      collection($, $.lbracket, $.rbracket, $.identifier, $.comma),

    // --- shapes ---
    // shape members are the same `name : Type [= default]` shape as top-level.
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

    // `derive UserId : Eq + Ord + Hash` — one line, several shapes.
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

    // --- tests ---
    test_declaration: ($) =>
      seq(
        $.kw_test,
        field("name", $.static_text),
        field("body", bracedSemiBlock($, $.test_statement)),
      ),
    test_statement: ($) => choice($.test_binding, $.expect_statement),
    test_binding: ($) => $.binding, // reuse the top-level binding form
    expect_statement: ($) => seq($.kw_expect, field("value", $.expression)),

    // --- names ---
    // both are just identifiers; separate rules so highlighting/outline can
    // tell a field from a binding. Keyword exclusion is already handled by
    // `word` + global reserved, so no reserved() wrap needed.
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
      leftAssocBinop( // non-assoc: no a < b < c
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
            $.kw_to,
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
            $.try_op,
            $.method_suffix,
          )),
        ),
      ),

    call_suffix: ($) =>
      seq(
        $.lparen,
        opt(separated1($, field("arg", $.call_argument), $.comma)),
        $.rparen,
      ),
    call_argument: ($) => $.expression,
    index_suffix: ($) =>
      seq($.lbracket, field("index", $.expression), $.rbracket),
    field_suffix: ($) => seq($.dot, field("field", $.field_name)), // . = reach into a value
    // @ = search for the implementation by type. The optional `:Shape` is now
    // only for a method name declared by two different shapes — implementations
    // are coherent, so there's never a choice between two of them.
    method_suffix: ($) =>
      seq(
        $.at_sign,
        field("method", $.identifier),
        opt(seq($.colon, field("shape", $.path))),
      ),
    record_suffix: ($) => field("body", $.record_body),

    // --- primary ---
    primary_expression: ($) =>
      choice(
        $.block_expression,
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

    // record_body doubles as an implementation body now:
    //   Task : Display = { show = fn(t) => t.name }
    record_builder: ($) =>
      seq($.kw_build, field("builder", $.path), $.builder_body),
    record_body: ($) => bracedCollection($, $.record_field, $.comma),
    builder_body: ($) => bracedCollection($, $.builder_field, $.comma),
    record_field: ($) =>
      choice(
        seq(field("name", $.field_name), $.equals, $.value_slot),
        $.spread_element,
      ),
    builder_field: ($) =>
      seq(field("name", $.field_name), $.left_arrow, $.value_slot),

    // --- control flow ---
    // block_expression: braces + semicolons + out + result. Replaces let..in.
    // `out` marks the value that exits the block (braces already mark scope).
    // This is now the only meaning of `out` — the type-parameter marker we
    // considered would have collided semantically, not syntactically.
    block_expression: ($) =>
      seq(
        $.lbrace,
        many(seq($.local_binding, $.semicolon)),
        $.kw_out,
        field("result", $.expression),
        $.rbrace,
      ),

    // local binding = value-namespace binding, no type constructors locally
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

    // `else =>` is NOT the same as `_ =>`. The totality checker treats else as
    // *deliberate* incompleteness: strict build warns and names the variants it
    // swallows, so adding a choice variant points you at every silent default.
    // A bare _ can't give you that audit. Lenient build shuts the warning up.
    match_arm: ($) =>
      choice(
        seq(field("pattern", $.pattern), $.fat_arrow, $.match_arm_value),
        seq($.kw_else, $.fat_arrow, $.match_arm_value),
      ),

    // Lambdas can now carry types:  fn (a: Int, b: Int) -> Int => a + b
    // Both parts optional, so `fn(a, b) => a + b` still parses. Without this
    // an inline lambda passed to a higher-order function had no annotation
    // site at all and inference had to win every time.
    //
    // NB: `fn(` also opens function_type. They live in disjoint positions
    // (expression vs type) so context separates them, but if tree-sitter
    // reports a conflict this pair is where to look — the `=>` is the only
    // thing that distinguishes them.
    lambda_parameter: ($) =>
      seq(
        field("pattern", $.binding_pattern),
        opt(seq($.colon, field("type_ann", $.type_expression))),
      ),
    lambda_parameters: ($) =>
      seq($.lparen, opt(parameterList($, $.lambda_parameter)), $.rparen),
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
        opt(bracketedWithRest(
          $,
          $.lparen,
          $.rparen,
          field("payload", $.tag_payload_pattern),
          $.comma,
          $.rest_pattern,
        )),
      ),
    // identical to atomic_pattern; aliased rather than duplicated. Split it back
    // out only if payload patterns ever need to diverge.
    tag_payload_pattern: ($) => $.pattern,

    wildcard_pattern: ($) => $.wildcard,
    unit_pattern: ($) => seq($.lparen, $.rparen),

    list_pattern: ($) =>
      bracketedWithRest(
        $,
        $.lbracket,
        $.rbracket,
        $.pattern,
        $.comma,
        $.rest_pattern,
      ),
    tuple_pattern: ($) => tuple($, $.pattern, $.comma),
    record_pattern: ($) =>
      bracketedWithRest(
        $,
        $.lbrace,
        $.rbrace,
        $.record_pattern_field,
        $.comma,
        $.rest_op,
      ),
    record_pattern_field: ($) => fieldPattern($.field_name, $.colon, $.pattern),
    rest_pattern: ($) => seq($.rest_op, field("binding", $.identifier)),

    // binding_pattern = the irrefutable subset (params, let bindings). No
    // literals / constructors, because you can't fail to match a fn param.
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
      bracketedWithRest(
        $,
        $.lbracket,
        $.rbracket,
        $.binding_pattern,
        $.comma,
        $.rest_pattern,
      ),
    binding_tuple_pattern: ($) => tuple($, $.binding_pattern, $.comma),
    binding_record_pattern: ($) =>
      bracketedWithRest(
        $,
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

    // List[T], Map[K,V], Iterator[Task], Tree[Text, Task].
    // A keyed container names its key type here. That's data, not an
    // implementation name — nothing about which impl was chosen ever appears
    // in a public type.
    path_or_applied: ($) =>
      seq(
        field("constructor", $.path),
        opt(field("args", $.type_argument_list)),
      ),
    type_argument_list: ($) =>
      collection($, $.lbracket, $.rbracket, $.type_expression, $.comma),

    // -> vs ->! surfaced as different tokens so the effect checker can branch
    // on which was actually written. bare -> on higher-order = effect-poly.
    function_type: ($) =>
      seq(
        $.kw_fn,
        collection(
          $,
          $.lparen,
          $.rparen,
          field("param", $.type_expression),
          $.comma,
        ),
        opt(seq(
          field("arrow", choice($.arrow, $.effect_arrow)),
          field("result", $.type_expression),
        )),
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
    tuple_type: ($) => tuple($, $.type_expression, $.comma),
    self_type: ($) => $.kw_Self,
    unit_type: ($) => seq($.lparen, $.rparen),
    wildcard_type: ($) => $.wildcard,
    parenthesized_type: ($) => seq($.lparen, $.type_expression, $.rparen),

    // --- constraints ---
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

    // percent before float before int — longest match wins, and 1.5% / 1.5 / 1
    // all share a prefix, so order matters here.
    percent_literal: ($) =>
      token(choice(
        new RustRegex(`${DEC_DIGITS}\\.${DEC_DIGITS}${EXPONENT}?${PERCENT}`),
        new RustRegex(`${DEC_DIGITS}\\.${EXPONENT}?${PERCENT}`),
        new RustRegex(`\\.${DEC_DIGITS}${EXPONENT}?${PERCENT}`),
        new RustRegex(`${DEC_DIGITS}${EXPONENT}?${PERCENT}`),
      )),
    float_literal: ($) =>
      token(choice(
        new RustRegex(
          `${DEC_DIGITS}\\.${DEC_DIGITS}${EXPONENT}?${FLOAT_SUFFIX}`,
        ),
        new RustRegex(`${DEC_DIGITS}\\.${EXPONENT}?${FLOAT_SUFFIX}`),
        new RustRegex(`\\.${DEC_DIGITS}${EXPONENT}?${FLOAT_SUFFIX}`),
        new RustRegex(`${DEC_DIGITS}${EXPONENT}${FLOAT_SUFFIX}`), // 1e9 — needs exponent or it's an int
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

    // interpolating string. static_text is the same minus interpolation —
    // used where a compile-time constant string is required (test names, attrs).
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
        many(choice($.static_text_content, $.escape_sequence)),
        $.quote,
      ),
    static_text_content: ($) => token(new RustRegex('[^"\\\\\\r\\n]+')),
    interpolation: ($) => seq($.interpolation_start, $.expression, $.rparen),
    interpolation_start: ($) => token(new RustRegex("\\\\\\(")), // \(
    escape_sequence: ($) => token(new RustRegex(`\\\\${ESCAPE_BODY}`)),

    // --- comments ---
    // block comments are /> ... </ so they don't collide with the / divide op
    // or // line comments. yes it looks like XML. live with it.
    line_comment: (_) => token(new RustRegex("//[^\\n]*")),
    block_comment: (_) => token(seq("/>", /([^<]|<[^/])*/, "</")),

    // --- identifiers, paths, operators ---
    // No trailing ! on identifiers. In a total/pure language the set!/map!
    // convention means nothing — there's no mutation to mark. ! belongs to the
    // effect arrow and nothing else.
    identifier: ($) =>
      token(new RustRegex("[_\\p{ID_Start}][\\p{ID_Continue}]*")),
    path_head: ($) => choice($.identifier, $.kw_self),
    path: ($) => seq($.path_head, repeat(seq($.module_sep, $.identifier))),
    // `$` is the one-argument lambda hole. Scope is the whole RHS of the
    // enclosing binding — resolver rule, not a grammar rule. `$.field` parses
    // as placeholder + field_suffix and needs nothing extra here.
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
    lparen_hash: () => token("#("), // tuple open — disambiguates from a paren'd expr
    lbracket_map: () => token("#["), // map open — vs list [
    quote: () => '"',
    comma: () => ",",
    colon: () => ":",
    equals: () => "=",
    semicolon: () => ";",
    dot: () => token.immediate("."), // immediate: no space before, so it's a suffix not a float
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

    // single token so ->! can't get lexed as -> followed by !=
    arrow: () => "->",
    effect_arrow: () => token("->!"),
    left_arrow: () => "<-",
    fat_arrow: () => "=>",
    try_op: () => "?",
  },
});
