// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1: CONSTANTS & TOKEN HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const PREC = {
	// Lowest to highest precedence
	PIPE: 1,
	OR: 2,
	AND: 3,
	COMPARE: 4,
	ADD: 5,
	MUL: 6,
	UNARY: 7,
	POSTFIX: 8, // unified postfix chain (calls, fields, try operator)
};

// Keyword helper: creates a keyword token with standard precedence (2)
function kw(s) {
	return ($) => token(prec(2, s));
}

// Operator helper: creates an operator token with specified precedence
function op(p, s) {
	return ($) => token(prec(p, s));
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2: GRAMMAR METADATA & CONFIGURATION
// ═════════════════════════════════════════════════════════════════════════════

module.exports = grammar({
	name: "kippy",

	// tree-sitter uses this for keyword extraction and error recovery.
	word: ($) => $.identifier,

	// layout-sensitive tokens are provided externally by the scanner.
	externals: ($) => [
		$.newline,
		$.indent,
		$.dedent,
	],

	// whitespace and comments are ignored everywhere unless explicitly required.
	// Comments are also explicitly handled at declaration level for predictable formatter attachment.
	extras: ($) => [
		/[ \t\r\f]+/,
		$.line_comment,
		$.block_comment,
	],

	supertypes: ($) => [
		$.expression,
		$.postfix_expression,
	],

	// ═════════════════════════════════════════════════════════════════════════════
	// SECTION 3: GRAMMAR RULES
	// ═════════════════════════════════════════════════════════════════════════════
	rules: {
		// ═════════════════════════════════════════════════════════════════════════════
		// FORMATTER COMMENT ATTACHMENT RULES
		// ═════════════════════════════════════════════════════════════════════════════
		// Comments appear in extras and can be found anywhere, but formatters should
		// follow these predictable attachment rules:
		//
		// 1. Doc Comments (///) bind to the next declaration only.
		//    Examples:
		//      /// Computes the sum
		//      let add x y = x + y
		//
		//      /// User account
		//      type User = { name: String, age: Int }
		//
		// 2. End-of-line comments (//) stay trailing if short (same line or next line).
		//    Examples:
		//      let x = 42  // Important value
		//      let y = f x // Result of computation
		//
		// 3. Block comments (</ ... />) between attributes/decorators and declarations
		//    attach to the declaration that follows.
		//    Examples:
		//      @deprecated
		//      </ Replaced by newFunction />
		//      let oldFunction x = ...
		//
		// Semantic wrapper node (documented_declaration) marks declaration
		// attachment points to help formatters make consistent decisions.
		// ═════════════════════════════════════════════════════════════════════════════

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.1: TOP-LEVEL & SOURCE FILE
		// ─────────────────────────────────────────────────────────────────────────────
		// A source file is a newline-separated list of module items.
		// Leading and trailing blank lines are allowed.
		// Multiple items cannot share one line.
		// Source file: optional module header and optional declarations.
		// Module header is optional; files can contain just declarations or be empty.
		source_file: ($) =>
			choice(
				repeat($.newline),
				seq(
					repeat($.newline),
					$.module_declaration,
					repeat($.newline),
				),
				seq(
					repeat($.newline),
					optional(seq(
						$.module_declaration,
						repeat1($.newline),
					)),
					$.module_item,
					repeat(seq(repeat1($.newline), $.module_item)),
					repeat($.newline),
				),
			),

		// top-level declarations supported by the module.
		// Leading comments (doc_comment, line_comment, block_comment) attached to each declaration.
		// Formatter rule: Comments immediately before a declaration belong to that declaration.
		// Note: module_declaration is handled separately by source_file (must be first).
		module_item: ($) =>
			choice(
				$.use_statement,
				$.documented_declaration,
			),

		// Semantic wrapper for declarations with optional leading documentation.
		// Attaches doc comments to any declarable item.
		documented_declaration: ($) =>
			seq(
				optional(seq(
					field("docs", $.doc_comment),
					$.newline,
				)),
				choice(
					$.type_declaration,
					$.signature,
					$.let_binding,
					$.ability_declaration,
					$.test_declaration,
					$.expect_statement,
					$.implementation,
				),
			),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.2: MODULE & USE DECLARATIONS
		// ─────────────────────────────────────────────────────────────────────────────
		// import/reference another module path.
		use_statement: ($) =>
			seq(
				$.kw_use,
				field("module", $.type_name),
				optional(seq(
					$.kw_as,
					field("alias", $.tag_name),
				)),
				optional(seq(
					$.kw_using,
					layoutBracket($, $.lparen, $.rparen, $.import_name),
				)),
			),

		//
		// Nested module declaration with an indented body.
		// Example:
		//   module Foo
		//     let x = 1
		// File-header module declaration.
		// Declares which module this file belongs to.
		// Optional, at most one per file, must come before other declarations.
		// Example: module Foo.Bar
		module_declaration: ($) =>
			seq(
				$.kw_module,
				field("name", $.type_name),
			),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.3: TYPE DECLARATIONS & VARIANTS
		// ─────────────────────────────────────────────────────────────────────────────
		// Type alias / type declaration.
		// Parameters are bare identifiers after the type name.
		type_declaration: ($) =>
			seq(
				attribute_prefix($),
				$.kw_type,
				field("name", $.type_name),
				optional($.type_parameter_list),
				$.equals,
				field(
					"value",
					choice(
						$.type_expression,
						$.type_variant_block,
					),
				),
			),

		// Type parameter list: (A, B, C)
		type_parameter_list: ($) =>
			seq(
				$.lparen,
				commaSep1Trail($, $.identifier, $.comma, $.newline),
				$.rparen,
			),

		// Indented variant block for type declarations:
		//   type Maybe(A) =
		//     | Some(A)
		//     | None
		type_variant_block: ($) =>
			indented_list($, $.type_variant, { at_least_one: true }),

		// one type variant: | TagName or | TagName(args)
		type_variant: ($) =>
			seq(
				$.pipe_bar,
				field("name", $.tag_name),
				optional(
					seq(
						$.lparen,
						commaSep1Trail($, $.type_expression, $.comma, $.newline),
						$.rparen,
					),
				),
			),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.4: ANNOTATIONS & SIGNATURES
		// ─────────────────────────────────────────────────────────────────────────────
		// Standalone annotation node used by ability method declarations.
		// Supports leading attributes and same-line or indented type bodies.
		annotation: ($) =>
			seq(
				attribute_prefix($),
				field("name", $.binding_target),
				$.colon,
				field("type", inline_or_block($, $.type_expression)),
				optional(field("constraints", $.constraint_clause)),
			),

		// top-level signature declaration.
		signature: ($) =>
			seq(
				attribute_prefix($),
				$.kw_sig,
				field("name", $.identifier),
				$.colon,
				field("type", inline_or_block($, $.type_expression)),
				optional(field("constraints", $.constraint_clause)),
			),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.5: VALUE BINDINGS & LET DECLARATIONS
		// ─────────────────────────────────────────────────────────────────────────────
		// Value definitions support:
		//   let name : Type
		//   let name = expr
		//   let name : Type = expr
		// Also supports attributes and pub modifiers.
		let_binding: ($) =>
			seq(
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

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.6: ATTRIBUTES & METADATA
		// ─────────────────────────────────────────────────────────────────────────────
		// Attributes with optional arguments.
		// Arguments must be on the same line as the attribute name (token.immediate).
		// Examples:
		//   @deprecated
		//   @inline
		//   @optimize.inline
		//   @deprecated("reason")
		//   @optimize(inline: true)
		attribute: ($) =>
			seq(
				"@",
				$.long_identifier,
				optional($.attribute_arguments_inline),
			),

		// attribute argument list: opening paren must be on same line as attribute name (token.immediate),
		// but arguments can span multiple lines if needed.
		attribute_arguments_inline: ($) =>
			seq(
				$.lparen,
				optional(commaSepTrail($, $.attribute_argument, $.comma, $.newline)),
				$.rparen,
			),

		// attribute argument: either expression or named argument.
		attribute_argument: ($) =>
			choice(
				$.expression,
				seq(field("name", $.identifier), $.colon, field("value", $.expression)),
			),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.7: IMPLEMENTATIONS & ABILITIES
		// ─────────────────────────────────────────────────────────────────────────────
		// implement an ability for a concrete type.
		implementation: ($) =>
			seq(
				$.kw_implement,
				field("ability", $.type_name),
				$.kw_for,
				field("type", $.type_name),
				field("methods", indented_list($, $.let_binding)),
			),

		// Ability declaration with indented method annotations.
		// Example:
		//   ability Writer
		//     write: File -> Bytes -> Void
		//   ability Reader
		//     read: File -> Bytes
		ability_declaration: ($) =>
			seq(
				attribute_prefix($),
				$.kw_ability,
				field("name", $.type_name),
				field(
					"methods",
					indented_list($, $.annotation, { at_least_one: true }),
				),
			),

		// assertion/expectation form.
		expect_statement: ($) => seq($.kw_expect, field("value", $.expression)),

		// test declaration with string name and indented body.
		// Body supports any expression (let bindings, when/if, expect, etc).
		// Syntax:
		//   test "test name":
		//     let x = 1
		//     expect x == 1
		//
		//   test "conditional":
		//     when value is
		//       Ok x => expect x == 5
		//       Err _ => expect false
		test_declaration: ($) =>
			seq(
				attribute_prefix($),
				$.kw_test,
				field("name", $.static_string),
				$.colon,
				field("body", indented_body($, $.expression)),
			),

		// Binding target is a simple lowercase identifier.
		// No dotted paths (language is immutable - no field assignment).
		binding_target: ($) => $.identifier,

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.8: EXPRESSION HIERARCHY (Operators by Precedence)
		// ─────────────────────────────────────────────────────────────────────────────
		// expression entry point.
		expression: ($) => $.pipe_expression,

		// Argument expressions in `with` calls are restricted to prevent ambiguity.
		// Bare arguments exclude clause-like forms (if, when, fn, block, with).
		// Clause forms must be parenthesized: f with (if c then a else b)
		// Example: `f with a + b` is valid, but `f with if c then a else b` requires parens.
		call_argument: ($) => $.bare_call_argument,

		// pipeline is lowest-precedence expression form.
		// Uses explicit binary nodes for better formatter and diagnostics support.
		pipe_expression: ($) =>
			prec.right(
				PREC.PIPE,
				choice(
					$.or_expression,
					seq($.pipe_expression, $.pipe, $.or_expression),
				),
			),

		or_expression: ($) => or_rule($, $.and_expression),

		and_expression: ($) => and_rule($, $.compare_expression),

		// Comparison allows at most one comparator per node.
		// Chained comparisons like a < b < c are not parsed as a single expression here.
		compare_expression: ($) => compare_rule($, $.add_expression),

		add_expression: ($) => add_rule($, $.mul_expression),

		mul_expression: ($) => mul_rule($, $.unary_expression),

		// unary negation and logical not bind tighter than binary operators.
		unary_expression: ($) =>
			choice(
				prec.right(
					PREC.UNARY,
					seq(choice($.minus, $.kw_not, $.kw_cert), $.unary_expression),
				),
				$.postfix_expression,
			),

		// ═════════════════════════════════════════════════════════════════════════════
		// BARE CALL ARGUMENT EXPRESSIONS (stricter than full expressions)
		// ═════════════════════════════════════════════════════════════════════════════
		// Used for unparenthesized arguments in `with` calls.
		// Excludes clause-like forms (if, when, fn, block, with) unless parenthesized.
		// Example: `f with x + y` is valid, but `f with if c then a else b` requires parens.
		bare_call_argument: ($) => $.bare_or_expression,

		bare_or_expression: ($) => or_rule($, $.bare_and_expression),

		bare_and_expression: ($) => and_rule($, $.bare_compare_expression),

		bare_compare_expression: ($) => compare_rule($, $.bare_add_expression),

		bare_add_expression: ($) => add_rule($, $.bare_mul_expression),

		bare_mul_expression: ($) => mul_rule($, $.bare_unary_expression),

		// Unary expressions (right-associative): allows chaining like `--x`, `not not y`.
		bare_unary_expression: ($) =>
			choice(
				prec.right(
					PREC.UNARY,
					seq(choice($.minus, $.kw_not, $.kw_cert), $.bare_unary_expression),
				),
				$.bare_postfix_expression,
			),

		// Postfix expressions for bare arguments: allows field access and try, but NOT `with` calls.
		// Primary expressions that exclude clause-style constructs (when, if, fn, blocks).
		// Used by bare-call and condition expression hierarchies.
		// These remain usable through parenthesized_expression.
		non_clause_primary: ($) =>
			choice(
				$.record_builder,
				$.literal,
				$.long_identifier,
				$.placeholder,
				$.list_expression,
				$.record_expression,
				$.tuple_expression,
				$.parenthesized_expression,
			),

		bare_postfix_expression: ($) =>
			choice(
				$.non_clause_primary,
				prec.left(
					PREC.POSTFIX,
					seq(
						field("object", $.bare_postfix_expression),
						$.projection_suffix,
					),
				),
				prec.left(
					PREC.POSTFIX,
					seq(
						field("value", $.bare_postfix_expression),
						$.try_op,
					),
				),
			),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.9: POSTFIX EXPRESSIONS (Calls, Fields, Try)
		// ─────────────────────────────────────────────────────────────────────────────
		// Postfix expression is a choice of four semantic operations.
		// This allows postfix_expression to be a supertype (single visible child).
		// Each operation (call, field, try) is a separate named node with proper fields.
		postfix_expression: ($) =>
			choice(
				$.primary_expression,
				$.call_expression,
				$.field_expression,
				$.try_expression,
				$.receiver_method_expression,
			),

		// Function call with 'with' keyword and arguments
		call_expression: ($) =>
			prec.left(
				PREC.POSTFIX,
				seq(
					field("function", $.postfix_expression),
					field("arguments", $.call_suffix),
				),
			),

		// Field/property access
		field_expression: ($) =>
			prec.left(
				PREC.POSTFIX,
				seq(
					field("object", $.postfix_expression),
					$.dot,
					field("field", choice($.field_name, $.tuple_index)),
				),
			),

		// Try operator for error handling
		try_expression: ($) =>
			prec.left(
				PREC.POSTFIX,
				seq(
					field("value", $.postfix_expression),
					$.try_op,
				),
			),

		// Receiver method reference using apostrophe syntax
		// Syntax: receiver'method
		// Example: user'show, a'eq with b
		receiver_method_expression: ($) =>
			prec.left(
				PREC.POSTFIX,
				seq(
					field("receiver", $.postfix_expression),
					$.apostrophe,
					field("method", $.identifier),
				),
			),

		// Semantic node for record spread field (for formatter/diagnostics support)
		// Generic spread element: expands a collection's contents into context.
		// Used in lists, records, and other collection literals.
		// Example: [1, 2, ..rest], {a: 1, ..base}
		spread_element: ($) => seq("..", field("base", $.expression)),

		// function call suffix using 'with' keyword.
		// Syntax:
		//   func with x, y
		//   func with
		//     x,
		//     y
		call_suffix: ($) => with_call_suffix($),

		// field/property access suffix.
		// Syntax:
		//   obj.field
		//   obj.0 (tuple index)
		projection_suffix: ($) =>
			seq(
				$.dot,
				field("field", choice($.field_name, $.tuple_index)),
			),

		// numeric dot-field like .0, .1.
		tuple_index: ($) => token(/[0-9]+/),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.10: PRIMARY EXPRESSION FORMS
		// ─────────────────────────────────────────────────────────────────────────────
		// primary expressions are the irreducible expression forms.
		primary_expression: ($) =>
			choice(
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
		list_expression: ($) =>
			layoutBracket($, $.lbracket, $.rbracket, $.list_item),

		// List item: either a normal expression or spread element.
		// Example: [1, 2, ..xs] or [..transform with list]
		list_item: ($) =>
			choice(
				$.expression,
				$.spread_element,
			),

		// Record literal:
		//   { a: 1, b: 2 }
		//   { a: 1, ..base }
		//   { ..base }
		// Shared record body: single-line or multiline format.
		// Used by both record_expression and record_builder.
		record_body: ($) =>
			choice(
				singleLineRecordExpression($, $.record_field),
				multiLineRecordExpression($, $.record_field),
			),

		record_expression: ($) => $.record_body,

		// Record builder for applicative composition patterns.
		// Example:
		//   build decoder { x: dx, y: dy }
		record_builder: ($) =>
			seq(
				$.kw_build,
				field("builder", $.long_identifier),
				$.record_body,
			),

		// field name - allows identifiers and contextual keywords.
		field_name: ($) => $.identifier,

		// standardised field naming for downstream tooling.
		// Record field value: inline or multiline, but without trailing newline tolerance.
		// Used in comma-delimited containers where the container owns the separator boundary.
		record_field_value: ($) =>
			choice(
				$.expression,
				seq(
					$.newline,
					$.indent,
					$.expression,
					$.dedent,
				),
			),

		record_field: ($) =>
			seq(
				field("name", $.field_name),
				$.colon,
				field("value", $.record_field_value),
			),

		// tuple literal parser shared with type tuples.
		tuple_expression: ($) => tuple_like($, $.expression),

		// grouping expression, not tuple.
		parenthesized_expression: ($) =>
			seq(
				$.lparen,
				field("value", $.expression),
				$.rparen,
			),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.11: BLOCK & CONTROL FLOW EXPRESSIONS
		// ─────────────────────────────────────────────────────────────────────────────
		// Block expression:
		// (
		//   let x = 1
		//   in x + 1
		// )
		// or value-only:
		// (
		//   expr
		// )
		block_expression: ($) =>
			seq(
				$.lparen,
				$.newline,
				$.indent,
				choice(
					field("value", $.expression),
					seq(
						$.let_binding,
						repeat(seq(repeat1($.newline), $.let_binding)),
						repeat($.newline),
						$.kw_in,
						field("value", $.expression),
					),
				),
				repeat($.newline),
				$.dedent,
				$.rparen,
			),

		// Pattern matching expression with an indented arm list.
		when_expression: ($) =>
			seq(
				$.kw_when,
				field("subject", $.expression),
				$.kw_is,
				field("arms", indented_list($, $.when_arm, { at_least_one: true })),
			),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.12: PATTERN MATCHING
		// ─────────────────────────────────────────────────────────────────────────────
		// full pattern plus optional guard.
		pattern: ($) =>
			seq(
				$.or_pattern,
				optional(seq($.kw_if, field("guard", $.expression))),
			),

		// alternation patterns.
		or_pattern: ($) =>
			prec.left(seq(
				$.as_pattern,
				repeat(seq($.pipe_bar, $.as_pattern)),
			)),

		// binding the matched value after a successful subpattern match.
		as_pattern: ($) =>
			choice(
				seq($.atomic_pattern, $.kw_as, field("binding", $.identifier)),
				$.atomic_pattern,
			),

		// atomic patterns are the non-extendable pattern forms.
		atomic_pattern: ($) =>
			choice(
				$.literal,
				$.wildcard_pattern,
				$.identifier,
				$.tag_pattern,
				$.list_pattern,
				$.tuple_pattern,
				$.record_pattern,
				seq($.lparen, $.pattern, $.rparen),
			),

		// wildcard pattern.
		wildcard_pattern: ($) => "_",

		// Non-parenthesised patterns allowed as bare tag arguments.
		// Deliberately excludes tuple/parenthesised forms to avoid Tag(x) ambiguity.
		// Simple argument to tag pattern (bare form, no parens needed).
		// Restricted to prevent ambiguity: `Some Err x` is not allowed.
		// Must use parentheses for complex patterns: `Some (Err x)`, `Some ({ a })`.
		simple_tag_argument_pattern: ($) =>
			choice(
				$.literal,
				$.wildcard_pattern,
				$.identifier,
			),

		// Constructor/tag patterns:
		//   Tag
		//   Tag(x, y)
		//   Tag x          (only if x is literal, _, or identifier)
		//   Tag (Err x)    (complex patterns require parens)
		tag_pattern: ($) =>
			seq(
				$.tag_name,
				optional(choice(
					seq(
						$.lparen,
						commaSep1Trail($, $.pattern, $.comma, $.newline),
						$.rparen,
					),
					$.simple_tag_argument_pattern,
				)),
			),

		// List patterns:
		//   []
		//   [x, y]
		//   [x, ..rest]
		//   [..rest]
		list_pattern: ($) =>
			seq(
				$.lbracket,
				optional(choice(
					seq(
						$.pattern,
						repeat(seq($.comma, $.pattern)),
						optional(seq($.comma, $.rest_pattern)),
					),
					$.rest_pattern,
				)),
				$.rbracket,
			),

		// list tail binding.
		rest_pattern: ($) =>
			seq(
				"..",
				field("binding", $.identifier),
			),

		// Tuple pattern must contain a comma so it cannot be confused with grouping.
		// Syntax: #{x, y}
		tuple_pattern: ($) =>
			seq(
				$.lbrace_hash,
				$.pattern,
				$.comma,
				commaSepTrail($, $.pattern, $.comma, $.newline),
				$.rbrace,
			),

		// Record patterns:
		//   { age }
		//   { age: x }
		//   { age, .. }
		//   { .. }
		record_pattern: ($) =>
			seq(
				$.lbrace,
				optional(choice(
					seq(
						$.record_pattern_field,
						repeat(seq($.comma, $.record_pattern_field)),
						optional(seq($.comma, "..")),
					),
					"..",
				)),
				$.rbrace,
			),

		// shorthand field or explicit field pattern (allows keywords).
		record_pattern_field: ($) =>
			choice(
				seq($.field_name, $.colon, $.pattern),
				$.field_name,
			),

		// ═════════════════════════════════════════════════════════════════════════════
		// WHEN-ARM FORMATTER RULES
		// ═════════════════════════════════════════════════════════════════════════════
		// Semantic node for when-arm body expression. Formatters should apply these
		// consistent indentation rules for clarity and predictability:
		//
		// SIMPLE ARMS (stay inline):
		//   pattern => simple_expr
		//   pattern => x + 1
		//   pattern => f x
		//
		// BREAKING RULES (always indent once broken):
		//   - Contains let binding: pattern => let x = ... ; expr
		//   - Contains nested when/if: pattern => when y is ...
		//   - Contains long postfix chains: pattern => very_long_expr.field?.method(args)
		//   - Spans multiple lines: once broken, indent entire body
		//
		// INDENTED ARMS (always indented):
		//   pattern =>
		//     let x = y
		//     x + 1
		//
		//   pattern =>
		//     if cond then
		//       a
		//     else
		//       b
		// ═════════════════════════════════════════════════════════════════════════════
		arm_expression: ($) => inline_or_block($, $.expression),

		// one match arm and its result expression.
		when_arm: ($) =>
			seq(
				field("pattern", $.pattern),
				$.arrow_op,
				field("value", $.arm_expression),
			),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.13: LAMBDA & SPECIAL EXPRESSIONS
		// ─────────────────────────────────────────────────────────────────────────────
		// Lambda syntax:
		//   fn x:
		//   fn x, y, z:
		// Body may be same-line or indented.
		lambda_expression: ($) =>
			seq(
				$.kw_fn,
				field("param", $.identifier),
				repeat(seq(
					optional(repeat($.newline)),
					$.comma,
					optional(repeat($.newline)),
					field("param", $.identifier),
				)),
				$.colon,
				field("body", inline_or_block($, $.expression)),
			),

		// Primary expressions that exclude clause-style constructs (when, if, fn, blocks).
		// These remain usable through parenthesized_expression.
		condition_expression: ($) => $.condition_pipe,

		condition_pipe: ($) =>
			prec.right(
				PREC.PIPE,
				choice(
					$.condition_or,
					seq($.condition_pipe, $.pipe, $.condition_or),
				),
			),

		condition_or: ($) => or_rule($, $.condition_and),

		condition_and: ($) => and_rule($, $.condition_compare),

		condition_compare: ($) => compare_rule($, $.condition_add),

		condition_add: ($) => add_rule($, $.condition_mul),

		condition_mul: ($) => mul_rule($, $.condition_unary),

		condition_unary: ($) =>
			choice(
				prec.right(
					PREC.UNARY,
					seq(choice($.minus, $.kw_not, $.kw_cert), $.condition_unary),
				),
				$.condition_postfix,
			),

		condition_postfix: ($) =>
			choice(
				$.non_clause_primary,
				prec.left(
					PREC.POSTFIX,
					seq(
						field("object", $.condition_postfix),
						$.projection_suffix,
					),
				),
				prec.left(
					PREC.POSTFIX,
					seq(
						field("function", $.condition_postfix),
						field("arguments", $.call_suffix),
					),
				),
				prec.left(
					PREC.POSTFIX,
					seq(
						field("value", $.condition_postfix),
						$.try_op,
					),
				),
			),

		// expression-level if/then/else.
		if_expression: ($) =>
			seq(
				$.kw_if,
				field("condition", $.condition_expression),
				$.kw_then,
				field("then_value", $.if_branch),
				$.kw_else,
				field("else_value", $.if_branch),
			),

		// Helper for if-expression branches (supports both inline and multiline bodies).
		if_branch: ($) => inline_or_block($, $.expression),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.14: TYPE SYSTEM
		// ─────────────────────────────────────────────────────────────────────────────
		// Function types are parsed with arrow precedence lower than non-arrow types.
		// Supports:
		//   a -> b
		//   a, b -> c
		//   a -> b -> c
		type_expression: ($) =>
			prec.right(choice(
				seq(
					field(
						"left",
						choice(
							$.type_function_params,
							$.non_arrow_type,
						),
					),
					$.arrow_op,
					field("right", inline_or_block($, $.type_expression)),
				),
				$.non_arrow_type,
			)),

		// Restricted type expression: disallows top-level comma chains.
		// Used in comma-delimited contexts (record fields, tuple types, generic arguments).
		// Allows: String, A -> B, Foo(Bar, Baz), parenthesized types.
		// Disallows: A, B without parentheses (must be A -> B or similar).
		type_expression_no_comma: ($) =>
			prec.right(choice(
				seq(
					field("left", $.non_arrow_type),
					$.arrow_op,
					field("right", inline_or_block($, $.type_expression)),
				),
				$.non_arrow_type,
			)),

		// Type function parameters: comma-separated list of types on the left of an arrow.
		// Must have at least 2 items. Commas must follow immediately (no leading newlines).
		type_function_params: ($) =>
			seq(
				field("first", $.non_arrow_type),
				repeat1(seq(
					$.comma,
					repeat($.newline),
					field("rest", $.non_arrow_type),
				)),
			),

		// simple where-clause constraint.
		constraint_clause: ($) =>
			seq(
				$.kw_where,
				field("type_var", $.identifier),
				$.colon,
				field("constraint", $.non_arrow_type),
			),

		// non-arrow type forms (parenthesized arguments only).
		non_arrow_type: ($) =>
			choice(
				$.function_type,
				$.type_primary,
				$.type_tuple,
				$.type_record,
			),

		// Function type: requires fn keyword followed by parenthesized type expression.
		// Example: fn(Int -> String), fn(Int, Int -> Bool)
		function_type: ($) =>
			seq(
				$.kw_fn,
				$.lparen,
				$.type_expression,
				$.rparen,
			),

		// Semantic node for generic type application (for formatter/diagnostics support)
		type_application: ($) => seq($.type_name, $.type_argument_list),

		// Type variables: lowercase identifiers used in generic types.
		// Example: `a` and `e` in `Maybe(a)` and `Result(a, e)`
		type_variable: ($) => $.identifier,

		// atomic type forms.
		type_primary: ($) =>
			choice(
				$.type_application,
				$.type_name,
				$.type_variable,
				alias("_", $.type_wildcard),
				alias("*", $.type_star),
				$.parenthesized_type,
			),

		//
		// Qualified type name without arguments (uppercase only).
		// Arguments are handled separately by type_primary.
		// Example:
		//   Foo
		//   Mod.Foo
		type_name: ($) => dotted1($, $.tag_name, $.tag_name),

		// explicit parenthesised type argument list.
		// Uses restricted type form to avoid ambiguity with argument separator commas.
		type_argument_list: ($) =>
			seq(
				$.lparen,
				optional(seq(
					field("first", $.type_expression_no_comma),
					field(
						"rest",
						repeat(seq($.comma, repeat($.newline), $.type_expression_no_comma)),
					),
					optional(seq(repeat($.newline), $.comma)),
				)),
				$.rparen,
			),

		// record type field (allows keywords as field names).
		// Uses restricted type form to avoid ambiguity with record field comma separator.
		record_type_field: ($) =>
			seq(
				$.field_name,
				$.colon,
				inline_or_block($, $.type_expression_no_comma),
			),

		// tuple type.
		type_tuple: ($) => tuple_like($, $.non_arrow_type),

		// grouped type expression.
		parenthesized_type: ($) => seq($.lparen, $.type_expression, $.rparen),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.15: LITERALS & STRING FORMS
		// ─────────────────────────────────────────────────────────────────────────────
		// literal forms available in both expressions and patterns.
		literal: ($) =>
			choice(
				$.int_literal,
				$.float_literal,
				$.char_literal,
				$.string,
				$.multiline_string,
			),

		// decimal/scientific floating-point formats with optional f32/f64 suffix.
		float_literal: ($) =>
			token(choice(
				/[0-9][0-9_]*\.[0-9][0-9_]*(?:[eE][+-]?[0-9_]+)?(?:f32|f64)?/,
				/[0-9][0-9_]*\.(?:[eE][+-]?[0-9_]+)?(?:f32|f64)?/,
				/\.[0-9][0-9_]*(?:[eE][+-]?[0-9_]+)?(?:f32|f64)?/,
				/[0-9][0-9_]*[eE][+-]?[0-9_]+(?:f32|f64)?/,
			)),

		// integer literal formats with optional signed/unsigned width suffixes.
		int_literal: ($) =>
			token(choice(
				/0[bB][01][01_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?/,
				/0[oO][0-7][0-7_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?/,
				/0[xX][0-9a-fA-F][0-9a-fA-F_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?/,
				/[0-9][0-9_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?/,
			)),

		// Normal string with escapes and interpolation.
		// Interpolation starts with \( and ends at the matching parser-level ).
		string: ($) =>
			seq(
				$.quote,
				repeat(choice(
					$.string_text,
					$.escape_sequence,
					$.interpolation,
				)),
				$.quote,
			),

		// Triple-quoted multiline string with interpolation and controlled quote tokenisation.
		multiline_string: ($) =>
			seq(
				$.triple_quote,
				repeat(choice(
					$.multiline_text,
					$.escape_sequence,
					$.interpolation,
					$.multiline_quote,
					$.multiline_double_quote,
				)),
				$.triple_quote,
			),

		// Character literal: single-quoted character with escape support.
		// Syntax: 'a', 'x', '\n', '\u0041', etc.
		char_literal: ($) =>
			seq(
				$.single_quote,
				choice(
					$.escape_sequence,
					/[^'\\]/, // any character except quote or backslash
				),
				$.single_quote,
			),

		// embedded expression interpolation in strings.
		interpolation: ($) =>
			seq(
				$.interpolation_start,
				$.expression,
				$.rparen,
			),

		// token for the start of interpolation.
		interpolation_start: ($) => token(/\\\(/),

		// plain single-line string content excluding quotes, backslashes, and newlines.
		string_text: ($) => token(/[^"\\\n]+/),

		//
		// Multiline quote token design deliberately avoids consuming the closing """ delimiter.
		multiline_text: ($) => token(/[^\\"]+/),
		multiline_quote: ($) => token(/"[^"]/),
		multiline_double_quote: ($) => token(/""[^"]/),

		// supported escape sequences.
		escape_sequence: ($) => token(/\\(u\([0-9A-Fa-f]{1,8}\)|[\\'"ntrbfv])/),

		// Static string literal: double-quoted string without interpolation.
		// Used for constant strings like test names.
		static_string: ($) =>
			seq(
				'"',
				repeat(choice(
					$.static_string_text,
					$.escape_sequence,
				)),
				'"',
			),

		// Static string text content (no interpolation).
		static_string_text: ($) => token(/[^"\\\n]+/),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.16: COMMENTS
		// ─────────────────────────────────────────────────────────────────────────────
		// comment forms, all treated as extras.
		doc_comment: (_) =>
			token(
				prec(
					2,
					seq(
						"///",
						/[^\n]*/,
						repeat(seq("\n", "///", /[^\n]*/)),
					),
				),
			),
		line_comment: (_) => token(prec(1, /\/\/[^\n]*/)),
		block_comment: ($) =>
			token(prec(
				-3,
				seq(
					"</",
					repeat(choice(
						/[^/]/,
						/\/[^>]/,
					)),
					"/>",
				),
			)),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.17: IDENTIFIERS & KEYWORDS
		// ─────────────────────────────────────────────────────────────────────────────
		// Lowercase-style identifiers, optionally prefixed by underscores and optionally ending in !.
		// Trailing ! marks effectful functions/values.
		// Cannot match reserved keywords (see keyword declarations below).
		// Token precedence 1; keywords have precedence 2 and will be preferred by the lexer.
		identifier: ($) => token(prec(1, /(_*[a-z][a-zA-Z0-9_]*!?)/)),

		// constructor/type/tag names are uppercase-initial.
		tag_name: ($) => token(/(_*[A-Z][a-zA-Z0-9_]*)/),

		// Import name: can be identifier or tag name.
		// Used in use_statement for selective imports.
		// Example: use Data.Json.Decode using (run, field, Some, None)
		import_name: ($) => choice($.identifier, $.tag_name),

		// name may be lowercase identifier or uppercase tag/type name.
		name: ($) => choice($.identifier, $.tag_name),

		// dotted qualified identifier/type path.
		long_identifier: ($) => prec.left(dotted1($, $.name, $.name)),

		// placeholder expression token.
		placeholder: ($) => token("__"),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.18: OPERATORS & PUNCTUATION
		// ─────────────────────────────────────────────────────────────────────────────
		// Reserved
		kw_pub: ($) => token(prec(2, "pub")),
		kw_let: ($) => token(prec(2, "let")),
		kw_cert: ($) => token(prec(2, "cert")),
		kw_expect: ($) => token(prec(2, "expect")),
		kw_if: ($) => token(prec(2, "if")),
		kw_then: ($) => token(prec(2, "then")),
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
		kw_using: kw("using"),
		kw_build: kw("build"),
		kw_for: kw("for"),
		kw_type: kw("type"),
		kw_sig: kw("sig"),
		kw_fn: kw("fn"),
		kw_test: kw("test"),
		kw_or: kw("or"),
		kw_and: kw("and"),
		kw_not: kw("not"),
		kw_as: kw("as"),

		// punctuation and operator tokens.
		lparen: ($) => "(",
		rparen: ($) => ")",
		lbracket: ($) => "[",
		rbracket: ($) => "]",
		lbrace: ($) => "{",
		rbrace: ($) => "}",
		// tuple constructor: #{x, y}
		lbrace_hash: ($) => token("#{"),

		// Quote delimiters for pair matching
		quote: ($) => '"',
		triple_quote: ($) => token('"""'),
		single_quote: ($) => "'",

		comma: ($) => ",",
		colon: ($) => ":",
		equals: op(2, "="),
		dot: ($) => token.immediate("."),

		//
		// |> must tokenise before plain | to avoid partial matches.
		pipe: ($) => token("|>"),
		pipe_bar: ($) => token("|"),

		or_op: ($) => $.kw_or,
		and_op: ($) => $.kw_and,
		not_kw: ($) => $.kw_not,

		plus: ($) => "+",
		minus: ($) => "-",
		star: ($) => "*",
		slash: ($) => "/",
		percent: ($) => "%",

		//
		// Longer comparison operators are given higher precedence to avoid ambiguity.
		eq_op: op(3, "=="),
		ne_op: op(3, "!="),
		le_op: op(4, "<="),
		ge_op: op(4, ">="),
		lt_op: op(3, "<"),
		gt_op: op(3, ">"),

		arrow_op: ($) => "->",
		try_op: ($) => "?",
		apostrophe: ($) => token.immediate("'"),

		// record type literal syntax.
		type_record: ($) =>
			layoutBracket($, $.lbrace, $.rbrace, $.record_type_field),

		// wildcard and star type atoms.
		type_wildcard: ($) => "_",
		type_star: ($) => "*",
	},
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4: HELPER FUNCTIONS
// ═════════════════════════════════════════════════════════════════════════════

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

// Top-level items: module items separated by required newlines.
// Used after module header in source_file.
// Indented body: newline, indent, rule, trailing newlines, dedent.
// Used for constructs with a single logical body (not a list of peer items).
function indented_body($, rule) {
	return seq(
		$.newline,
		$.indent,
		rule,
		repeat($.newline),
		$.dedent,
	);
}

// Indented list of items: handles zero or more items with newline separators.
// Set at_least_one=true to require at least one item.
// Used for constructs with a list of peer items (module items, when arms, type variants, etc).
function indented_list($, item, { at_least_one = false } = {}) {
	const body = at_least_one
		? seq(
			item,
			repeat(seq($.newline, item)),
		)
		: optional(seq(
			item,
			repeat(seq($.newline, item)),
		));

	return seq(
		$.newline,
		$.indent,
		body,
		repeat($.newline),
		$.dedent,
	);
}

// Unified body helper for same-line or indented bodies.
// - same line: = expr
// - indented:  =\n  expr
function inline_or_block($, rule) {
	return choice(
		rule,
		indented_body($, rule),
	);
}

// Dotted name helper for qualified identifiers.
// Matches: head (. tail)*
// Used for: type_name, long_identifier, binding_target
function dotted1($, head, tail) {
	return seq(
		head,
		repeat(seq($.dot, tail)),
	);
}

// Attribute prefix for declarations that support attributes.
// Each attribute must be on its own line. Blank lines after attributes are allowed.
function attribute_prefix($) {
	return repeat(seq($.attribute, $.newline));
}

// Left-associative operator chain precedence helper.
// Produces a flat concrete syntax tree: operand (operator operand)*
function left_assoc_chain(precValue, operand, operator) {
	return prec.left(
		precValue,
		seq(
			operand,
			repeat(seq(operator, operand)),
		),
	);
}

// ═════════════════════════════════════════════════════════════════════════════
// Operator Ladder Helpers
// ═════════════════════════════════════════════════════════════════════════════
// These direct-style helpers reduce duplication across parallel expression hierarchies
// (normal, bare-call, condition). Update once, applies to all three.

function or_rule($, next_level) {
	return left_assoc_chain(PREC.OR, next_level, $.or_op);
}

function and_rule($, next_level) {
	return left_assoc_chain(PREC.AND, next_level, $.and_op);
}

function compare_rule($, next_level) {
	return prec.left(
		PREC.COMPARE,
		seq(
			next_level,
			optional(seq(
				choice($.le_op, $.ge_op, $.eq_op, $.ne_op, $.lt_op, $.gt_op),
				next_level,
			)),
		),
	);
}

function add_rule($, next_level) {
	return left_assoc_chain(PREC.ADD, next_level, choice($.plus, $.minus));
}

function mul_rule($, next_level) {
	return left_assoc_chain(
		PREC.MUL,
		next_level,
		choice($.star, $.slash, $.percent),
	);
}

function postfix_rule($, base, ...suffixes) {
	return prec.left(
		PREC.POSTFIX,
		seq(
			base,
			repeat(choice(...suffixes)),
		),
	);
}

// Shared tuple parser for expression tuples and type tuples.
// Explicitly requires at least 2 items: first, comma, second, then optional rest.
// Syntax: #{x, y}
// Multiline tuples enforce strict comma-before-newline ordering.
function tuple_like($, itemRule) {
	return choice(
		// Single-line: #{x, y, z}
		seq(
			$.lbrace_hash,
			field("first", itemRule),
			$.comma,
			field("second", itemRule),
			repeat(seq($.comma, field("rest", itemRule))),
			optional($.comma),
			$.rbrace,
		),
		// Multiline with comma-newline ordering:
		// #{
		//   x,
		//   y,
		//   z
		// }
		seq(
			$.lbrace_hash,
			$.newline,
			$.indent,
			field("first", itemRule),
			$.comma,
			$.newline,
			field("second", itemRule),
			repeat(seq(
				$.comma,
				$.newline,
				field("rest", itemRule),
			)),
			optional($.comma),
			repeat($.newline),
			$.dedent,
			$.rbrace,
		),
	);
}

// Helper: function argument list using 'with' keyword without parentheses.
// Function call with 'with' keyword. Arguments are restricted (bare call arguments).
// Clause-like forms (if, when, fn, blocks) must be parenthesized in unparenthesized calls.
// Syntax:
//   func with x, y
//   func with (if c then a else b)
//   func with
//     x,
//     y,
//     z
// Single-line and multiline forms are distinct: single-line has no newline after 'with',
// multiline requires an indented block immediately after 'with'.
// Effects are marked by ! at the end of function/value names, not on the call.
function with_call_suffix($) {
	return choice(
		// Single-line: with x (exactly one argument)
		// Multi-argument with must use multiline form to avoid ambiguity in comma-delimited contexts.
		prec.right(seq(
			$.kw_with,
			field("arg", $.call_argument),
		)),
		// Multi-line: with x, y, z (one or more arguments)
		// with
		//   x,
		//   y,
		//   z
		seq(
			$.kw_with,
			$.newline,
			$.indent,
			field("first", $.call_argument),
			repeat(seq(
				$.comma,
				$.newline,
				field("rest", $.call_argument),
			)),
			optional($.comma),
			repeat($.newline),
			$.dedent,
		),
	);
}

// Multiline delimited list helper using indentation.
// Enforces comma followed by newlines before next item.
function multiLineBracket($, open, commaToken, item, close) {
	return seq(
		open,
		$.newline,
		$.indent,
		commaSep1TrailMultiline($, item, commaToken, $.newline),
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
// Comma comes before separator (if present): rule, comma, separator, rule
// Works for both single-line (no separator) and multiline (separator = newlines) contexts.
function commaSep1Trail($, rule, commaToken, sepToken) {
	return seq(
		rule,
		repeat(seq(
			commaToken,
			repeat(sepToken),
			rule,
		)),
		optional(seq(repeat(sepToken), commaToken)),
	);
}

// Strict multiline comma-separated sequence with required newlines after commas.
// For multiline-only contexts (lists, multiline brackets, etc).
// Enforces: comma followed by at least one separator (newline).
function commaSep1TrailMultiline($, rule, commaToken, sepToken) {
	return seq(
		rule,
		repeat(seq(
			commaToken,
			repeat1(sepToken),
			rule,
		)),
		optional(commaToken),
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
				optional(seq($.comma, $.spread_element)),
			),
			$.spread_element,
		)),
		$.rbrace,
	);
}

// Multiline record literal helper supporting fields and optional spread.
// Follows strict entry rule: fields/spread start immediately after indent.
// Policy matches single-line form:
//   - Fields first (zero or more), optionally followed by spread
//   - Or spread only
// Supports flexible newline placement around commas (same as commaSep1Trail).
// Examples: { a: 1, b: 2 } or { a: 1,\n  b: 2 } or { a: 1, ..base } or { ..base }
// NOT allowed: multiple spreads, spread before fields, fields after spread
function multiLineRecordExpression($, field) {
	return seq(
		$.lbrace,
		$.newline,
		$.indent,
		optional(choice(
			// Fields first, optional spread
			seq(
				field,
				repeat(seq(
					$.comma,
					repeat($.newline),
					field,
				)),
				optional(seq(
					$.comma,
					repeat($.newline),
					$.spread_element,
				)),
				optional($.comma),
			),
			// Spread only
			seq(
				$.spread_element,
				optional($.comma),
			),
		)),
		repeat($.newline),
		$.dedent,
		$.rbrace,
	);
}
