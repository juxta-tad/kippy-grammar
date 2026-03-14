// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1: CONSTANTS & PRECEDENCE
// ═════════════════════════════════════════════════════════════════════════════

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

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2: HELPER FUNCTIONS
// ═════════════════════════════════════════════════════════════════════════════

const opt = optional;
const many = repeat;
const many1 = repeat1;

// --- Basic Inline Separators ---
function sep1(rule, separator) {
	return seq(rule, many(seq(separator, rule)));
}

// --- Block & Layout Helpers ---
function block($, body) {
	return seq($.newline, $.indent, body, many($.newline), $.dedent);
}

function inlineOrBlock($, inlineRule, blockRule = inlineRule) {
	return choice(inlineRule, block($, blockRule));
}

function body($, inlineRule, blockRule = inlineRule) {
	return choice(
		inlineRule,
		block($, blockRule),
	);
}

function softBody($, inlineRule, blockRule = inlineRule) {
	return choice(
		body($, inlineRule, blockRule),
		seq(many1($.newline), $.parenthesized_expression),
	);
}

// --- Loose List Forms ---
function looseSeparated1($, rule, separator) {
	return seq(
		rule,
		many(choice(
			seq(separator, rule),
			seq(opt(separator), many1($.newline), rule),
		)),
		opt(separator),
	);
}

function looseSeparated($, rule, separator) {
	return opt(looseSeparated1($, rule, separator));
}

function layoutList1($, rule) {
	return seq(
		rule,
		many(seq(many1($.newline), rule)),
	);
}

// --- Unified Delimited Collections ---
function collection($, open, close, item, separator) {
	return seq(
		open,
		opt(seq(
			many($.newline),
			looseSeparated1($, item, separator),
			many($.newline),
		)),
		close,
	);
}

// --- Specific Construct Helpers ---
function separatedWithOptionalRest(item, separator, rest) {
	return opt(choice(
		seq(
			sep1(item, separator),
			opt(seq(separator, rest)),
		),
		rest,
	));
}

function fieldPattern(fieldName, colon, valueRule) {
	return choice(
		seq(fieldName, colon, valueRule),
		fieldName,
	);
}

function tuple($, open, close, item, sepToken) {
	return choice(
		seq(
			open,
			field("element", item),
			sepToken,
			field("element", item),
			many(seq(sepToken, field("element", item))),
			opt(sepToken),
			close,
		),
		seq(
			open,
			block(
				$,
				seq(
					field("element", item),
					seq(opt(sepToken), many1($.newline)),
					field("element", item),
					many(
						seq(seq(opt(sepToken), many1($.newline)), field("element", item)),
					),
					opt(sepToken),
				),
			),
			close,
		),
	);
}

// --- Common Patterns ---
function attrPrefix($) {
	return many(seq($.attribute, opt($.newline)));
}

function visibility_modifier($) {
	return opt($.kw_pub);
}

// --- Expression Ladder Generator ---
function buildExpressionLadder(prefix, baseRule) {
	return {
		[`${prefix}pipe_expression`]: ($) =>
			prec.left(
				PREC.PIPE,
				seq(
					$[`${prefix}or_expression`],
					many(seq($.pipe, $[`${prefix}or_expression`])),
				),
			),
		[`${prefix}or_expression`]: ($) =>
			prec.left(
				PREC.OR,
				seq(
					$[`${prefix}and_expression`],
					many(seq($.or_op, $[`${prefix}and_expression`])),
				),
			),
		[`${prefix}and_expression`]: ($) =>
			prec.left(
				PREC.AND,
				seq(
					$[`${prefix}compare_expression`],
					many(seq($.and_op, $[`${prefix}compare_expression`])),
				),
			),
		[`${prefix}compare_expression`]: ($) =>
			prec.left(
				PREC.COMPARE,
				seq(
					$[`${prefix}add_expression`],
					opt(seq(
						choice($.le_op, $.ge_op, $.eq_op, $.ne_op, $.lt_op, $.gt_op),
						$[`${prefix}add_expression`],
					)),
				),
			),
		[`${prefix}add_expression`]: ($) =>
			prec.left(
				PREC.ADD,
				seq(
					$[`${prefix}mul_expression`],
					many(seq(choice($.plus, $.minus), $[`${prefix}mul_expression`])),
				),
			),
		[`${prefix}mul_expression`]: ($) =>
			prec.left(
				PREC.MUL,
				seq(
					$[`${prefix}unary_expression`],
					many(
						seq(
							choice($.star, $.slash, $.percent),
							$[`${prefix}unary_expression`],
						),
					),
				),
			),
		[`${prefix}unary_expression`]: ($) =>
			choice(
				prec.right(
					PREC.UNARY,
					seq(
						choice($.minus, $.kw_not, $.kw_cert),
						$[`${prefix}unary_expression`],
					),
				),
				$[baseRule],
			),
	};
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3: GRAMMAR DEFINITION
// ═════════════════════════════════════════════════════════════════════════════

module.exports = grammar({
	name: "kippy",

	word: ($) => $.identifier,

	reserved: {
		global: ($) => [
			$.kw_pub,
			$.kw_let,
			$.kw_cert,
			$.kw_expect,
			$.kw_if,
			$.kw_then,
			$.kw_else,
			$.kw_match,
			$.kw_to,
			$.kw_in,
			$.kw_where,
			$.kw_with,
			$.kw_extend,
			$.kw_ability,
			$.kw_module,
			$.kw_use,
			$.kw_using,
			$.kw_build,
			$.kw_type,
			$.kw_distinct,
			$.kw_derives,
			$.kw_sig,
			$.kw_fn,
			$.kw_test,
			$.kw_or,
			$.kw_and,
			$.kw_not,
			$.kw_as,
			$.kw_self,
			$.kw_Self,
		],
	},

	externals: ($) => [
		$.newline,
		$.indent,
		$.dedent,
	],

	extras: ($) => [
		/[ \t\r\f]+/,
		$.line_comment,
		$.block_comment,
		$.doc_comment,
	],

	supertypes: ($) => [
		$.expression,
	],

	rules: {
		// ─────────────────────────────────────────────────────────────────────────
		// 3.1: TOP-LEVEL & SOURCE FILE
		// ─────────────────────────────────────────────────────────────────────────
		source_file: ($) =>
			seq(
				many($.newline),
				opt(seq($.module_declaration, many1($.newline))),
				many(seq($.module_item, many($.newline))),
			),

		module_item: ($) =>
			choice(
				$.use_statement,
				$.declaration,
			),

		declaration: ($) =>
			choice(
				$.type_declaration,
				$.signature,
				$.let_binding,
				$.ability_declaration,
				$.test_declaration,
				$.expect_statement,
				$.implementation,
			),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.2: MODULE & USE DECLARATIONS
		// ─────────────────────────────────────────────────────────────────────────
		use_statement: ($) =>
			seq(
				$.kw_use,
				field("module", $.type_name),
				opt(seq($.kw_as, field("alias", $.tag_name))),
				opt(
					seq(
						$.kw_using,
						collection($, $.lparen, $.rparen, $.import_name, $.comma),
					),
				),
			),

		module_declaration: ($) =>
			seq(
				$.kw_module,
				field("name", $.type_name),
			),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.3: TYPE DECLARATIONS & VARIANTS
		// ─────────────────────────────────────────────────────────────────────────
		type_declaration: ($) =>
			seq(
				attrPrefix($),
				visibility_modifier($),
				$.kw_type,
				field("name", $.type_name),
				opt($.type_parameter_list),
				$.equals,
				field("value", choice($.variant_type_value, $.alias_type_value)),
				opt($.derives_clause),
			),
		derives_clause: ($) =>
			seq(
				$.kw_derives,
				looseSeparated1($, field("ability", $.type_term), $.comma),
			),
		variant_type_value: ($) => prec(2, $.type_variant_block),

		alias_type_value: ($) =>
			prec(
				1,
				seq(
					opt($.kw_distinct),
					inlineOrBlock($, $.type_expression),
				),
			),

		type_parameter_list: ($) =>
			seq(
				$.lparen,
				looseSeparated($, $.type_variable, $.comma),
				$.rparen,
			),

		type_variant_block: ($) => block($, layoutList1($, $.type_variant)),

		type_variant: ($) =>
			seq(
				$.pipe_bar,
				field("name", $.tag_name),
				opt(field("payload", $.type_variant_payload)),
			),

		type_variant_payload: ($) =>
			seq(
				$.lparen,
				looseSeparated($, $.type_expression, $.comma),
				$.rparen,
			),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.4: ANNOTATIONS & SIGNATURES
		// ─────────────────────────────────────────────────────────────────────────
		annotation: ($) =>
			seq(
				attrPrefix($),
				field("name", $.binding_name),
				$.colon,
				field("type", inlineOrBlock($, $.type_expression)),
				opt(field("constraints", $.constraint_clause)),
			),

		signature: ($) =>
			seq(
				attrPrefix($),
				visibility_modifier($),
				$.kw_sig,
				field("name", $.identifier),
				$.colon,
				field("type", inlineOrBlock($, $.type_expression)),
				opt(field("constraints", $.constraint_clause)),
			),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.5: VALUE BINDINGS & LET DECLARATIONS
		// ─────────────────────────────────────────────────────────────────────────
		let_binding: ($) =>
			seq(
				attrPrefix($),
				visibility_modifier($),
				$.kw_let,
				$.binding_core,
			),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.6: ATTRIBUTES & METADATA
		// ─────────────────────────────────────────────────────────────────────────
		attribute: ($) =>
			seq(
				$.hash_sign,
				$.long_identifier,
				opt($.attribute_arguments_inline),
			),

		attribute_arguments_inline: ($) =>
			seq(
				$.lparen,
				looseSeparated($, $.attribute_argument, $.comma),
				$.rparen,
			),

		attribute_argument: ($) =>
			choice(
				$.expression,
				seq(
					field("name", $.identifier),
					$.equals,
					field("value", $.expression),
				),
			),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.7: IMPLEMENTATIONS & ABILITIES
		// ─────────────────────────────────────────────────────────────────────────
		implementation: ($) =>
			seq(
				attrPrefix($),
				visibility_modifier($),
				$.kw_extend,
				field("type", $.type_term),
				$.kw_with,
				field("ability", $.type_name),
				field(
					"methods",
					block($, layoutList1($, $.implementation_method)),
				),
			),

		implementation_method: ($) =>
			seq(
				field("name", $.identifier),
				$.equals,
				opt(many1($.newline)),
				$.kw_fn,
				$.kw_self,
				opt(seq($.comma, sep1(field("param", $.identifier), $.comma))),
				$.fat_arrow,
				field("body", softBody($, $.expression)),
			),

		ability_declaration: ($) =>
			seq(
				attrPrefix($),
				visibility_modifier($),
				$.kw_ability,
				field("name", $.type_name),
				opt($.type_parameter_list),
				field("methods", block($, layoutList1($, $.annotation))),
			),

		expect_statement: ($) => seq($.kw_expect, field("value", $.expression)),

		test_declaration: ($) =>
			seq(
				attrPrefix($),
				$.kw_test,
				field("name", $.static_string),
				$.colon,
				field("body", block($, $.expression)),
			),

		binding_core: ($) =>
			seq(
				field("pattern", $.binding_pattern),
				opt(seq($.colon, field("type", inlineOrBlock($, $.type_expression)))),
				$.equals,
				field("value", softBody($, $.expression)),
			),

		binding_name: ($) => reserved("global", $.identifier),

		receiver_parameter: ($) => $.kw_self,

		// ─────────────────────────────────────────────────────────────────────────
		// 3.8: EXPRESSION HIERARCHY
		// ─────────────────────────────────────────────────────────────────────────
		expression: ($) => $.pipe_expression,
		arm_inline_expression: ($) => $.arm_pipe_expression,
		call_argument: ($) => $["restricted_pipe_expression"],

		...buildExpressionLadder("", "postfix_expression"),
		...buildExpressionLadder("restricted_", "restricted_postfix_expression"),
		...buildExpressionLadder("arm_", "arm_postfix_expression"),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.9: POSTFIX EXPRESSIONS
		// ─────────────────────────────────────────────────────────────────────────

		arm_postfix_expression: ($) =>
			prec.left(
				PREC.POSTFIX,
				seq(
					$.inline_expression,
					many($.postfix_suffix),
					opt($.call_suffix),
					many($.postfix_suffix),
				),
			),

		postfix_expression: ($) =>
			prec.left(
				PREC.POSTFIX,
				seq(
					$.primary_expression,
					many($.postfix_suffix),
					opt($.call_suffix),
					many($.postfix_suffix),
				),
			),

		restricted_postfix_expression: ($) =>
			prec.left(
				PREC.POSTFIX,
				seq(
					$.primary_expression,
					many($.postfix_suffix),
					opt($.call_suffix),
					many($.postfix_suffix),
				),
			),

		postfix_suffix: ($) =>
			choice(
				field("indexing", $.index_suffix),
				$.method_suffix,
				$.qualified_method_suffix,
				$.try_op,
				seq($.possessive, field("field", $.field_name)),
			),

		index_suffix: ($) =>
			seq($.lbracket, field("index", $.expression), $.rbracket),
		method_suffix: ($) => seq($.dot, field("method", $.identifier)),
		qualified_method_suffix: ($) =>
			seq(
				$.at_sign,
				field("ability", $.type_name),
				$.dot,
				field("method", $.identifier),
			),

		call_suffix: ($) =>
			prec.right(
				seq(
					$.kw_with,
					inlineOrBlock($, looseSeparated1($, field("arg", $.call_argument), $.comma)),
				),
			),

		spread_element: ($) => seq($.rest_op, field("base", $.expression)),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.10: PRIMARY EXPRESSION FORMS
		// ─────────────────────────────────────────────────────────────────────────
		primary_expression: ($) =>
			choice(
				$.inline_expression,
				$.block_expression,
			),

		inline_expression: ($) =>
			choice(
				$.record_builder,
				$.literal,
				$.long_identifier,
				$.placeholder,
				$.list_expression,
				$.map_expression,
				$.record_expression,
				$.tuple_expression,
				$.parenthesized_expression,
			),

		block_expression: ($) =>
			choice(
				$.match_expression,
				$.if_expression,
				$.lambda_expression,
				$.let_expression,
			),

		// Collections
		list_expression: ($) =>
			collection($, $.lbracket, $.rbracket, $.list_item, $.semicolon),
		list_item: ($) => choice($.expression, $.spread_element),

		map_expression: ($) =>
			collection($, $.lbracket_hash, $.rbracket, $.map_entry, $.semicolon),
		map_entry: ($) =>
			seq(
				field("key", $.expression),
				$.fat_arrow,
				field("value", softBody($, $.expression)),
			),

		record_expression: ($) => $.record_body,
		record_builder: ($) =>
			seq($.kw_build, field("builder", $.long_identifier), $.record_body),
		record_body: ($) =>
			collection($, $.lbrace, $.rbrace, $.record_field, $.semicolon),

		// Allow spread natively as a valid "field" inside records instead of complicating helpers
		record_field: ($) =>
			choice(
				seq(
					field("name", $.field_name),
					$.equals,
					field("value", softBody($, $.expression)),
				),
				$.spread_element,
			),

		field_name: ($) => reserved("global", $.identifier),

		tuple_expression: ($) =>
			tuple($, $.lparen_hash, $.rparen, $.expression, $.semicolon),

		parenthesized_expression: ($) =>
			seq(
				$.lparen,
				choice(
					seq(
						many($.newline),
						field("value", $.expression),
						many($.newline),
					),
					block($, field("value", $.expression)),
				),
				$.rparen,
			),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.11: BLOCK & CONTROL FLOW EXPRESSIONS
		// ─────────────────────────────────────────────────────────────────────────

		let_expression: ($) =>
			prec.right(seq(
				$.kw_let,
				$.binding_core,
				many(seq(many1($.newline), $.binding_core)),
				opt(many1($.newline)),
				$.kw_in,
				field("value", softBody($, $.expression)),
			)),

		match_expression: ($) =>
			prec.right(seq(
				$.kw_match,
				field("subject", $.pipe_expression),
				$.kw_to,
				$.newline,
				$.indent,
				field("arms", repeat1($.match_arm)),
				$.dedent,
			)),

		match_arm: ($) =>
			seq(
				field("pattern", $.pattern),
				$.arrow,
				choice(
					seq(field("value", $.arm_inline_expression), many1($.newline)),
					seq(block($, field("value", $.expression)), many($.newline)),
				),
			),

		lambda_expression: ($) =>
			prec.right(seq(
				$.kw_fn,
				sep1(field("param", $.binding_pattern), $.comma),
				$.fat_arrow,
				field("body", softBody($, $.expression)),
			)),

		if_expression: ($) =>
			prec.right(seq(
				$.kw_if,
				field("condition", $.expression),
				$.kw_then,
				field("then_value", softBody($, $.expression)),
				$.kw_else,
				field("else_value", softBody($, $.expression)),
			)),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.12: PATTERN MATCHING
		// ─────────────────────────────────────────────────────────────────────────
		pattern: ($) =>
			seq($.unguarded_pattern, opt(seq($.kw_if, field("guard", $.expression)))),
		unguarded_pattern: ($) => $.or_pattern,

		binding_pattern: ($) =>
			choice(
				$.wildcard_pattern,
				$.identifier,
				$.binding_list_pattern,
				$.binding_tuple_pattern,
				$.binding_record_pattern,
			),

		or_pattern: ($) => prec.left(sep1($.as_pattern, $.pipe_bar)),

		as_pattern: ($) =>
			choice(
				seq($.atomic_pattern, $.kw_as, field("binding", $.identifier)),
				$.atomic_pattern,
			),

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

		wildcard_pattern: ($) => $.wildcard,

		// Binding-safe destructuring patterns (for let-bindings, excludes literals/or-patterns)
		binding_list_pattern: ($) =>
			seq(
				$.lbracket,
				separatedWithOptionalRest(
					$.binding_pattern,
					$.semicolon,
					$.rest_pattern,
				),
				$.rbracket,
			),

		binding_tuple_pattern: ($) =>
			tuple($, $.lparen_hash, $.rparen, $.binding_pattern, $.semicolon),

		binding_record_pattern: ($) =>
			seq(
				$.lbrace,
				separatedWithOptionalRest(
					$.binding_record_pattern_field,
					$.semicolon,
					$.rest_op,
				),
				$.rbrace,
			),

		binding_record_pattern_field: ($) =>
			fieldPattern($.field_name, $.colon, $.binding_pattern),

		simple_tag_argument_pattern: ($) =>
			choice($.literal, $.wildcard_pattern, $.identifier),

		tag_pattern: ($) =>
			seq(
				$.tag_name,
				opt(choice(
					seq($.lparen, looseSeparated1($, $.pattern, $.comma), $.rparen),
					$.simple_tag_argument_pattern,
				)),
			),

		list_pattern: ($) =>
			seq(
				$.lbracket,
				separatedWithOptionalRest($.pattern, $.semicolon, $.rest_pattern),
				$.rbracket,
			),

		rest_pattern: ($) => seq($.rest_op, field("binding", $.identifier)),

		tuple_pattern: ($) =>
			tuple($, $.lparen_hash, $.rparen, $.pattern, $.semicolon),

		record_pattern: ($) =>
			seq(
				$.lbrace,
				separatedWithOptionalRest(
					$.record_pattern_field,
					$.semicolon,
					$.rest_op,
				),
				$.rbrace,
			),

		record_pattern_field: ($) => fieldPattern($.field_name, $.colon, $.pattern),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.13: TYPE SYSTEM
		// ─────────────────────────────────────────────────────────────────────────
		type_expression: ($) => choice($.type_term, $.variadic_type),

		function_type_parameters: ($) =>
			looseSeparated1($, field("param", $.type_expression), $.comma),

		variadic_type: ($) => seq($.ellipsis, field("item", $.type_term)),
		ellipsis: ($) => token(prec(1, "...")),
		rest_op: ($) => "..",

		constraint_clause: ($) =>
			seq(
				$.kw_where,
				field("type_var", $.identifier),
				$.colon,
				field("constraint", $.type_term),
			),

		type_term: ($) =>
			choice($.function_type, $.type_primary, $.type_tuple, $.type_record),

		function_type: ($) =>
			seq(
				$.kw_fn,
				$.lparen,
				opt($.function_type_parameters),
				$.rparen,
				$.arrow,
				field("result", inlineOrBlock($, $.type_expression)),
			),

		type_application: ($) => seq($.type_name, $.type_argument_list),
		type_variable: ($) => reserved("global", $.identifier),

		self_type: ($) => $.kw_Self,

		type_primary: ($) =>
			choice(
				$.type_application,
				$.type_name,
				$.type_variable,
				$.self_type,
				$.type_wildcard,
				$.parenthesized_type,
			),
		type_name: ($) => seq($.tag_name, many(seq($.module_sep, $.tag_name))),

		type_argument_list: ($) =>
			seq(
				$.lparen,
				looseSeparated($, $.type_expression, $.comma),
				$.rparen,
			),

		record_type_field: ($) =>
			seq($.field_name, $.colon, inlineOrBlock($, $.type_expression)),
		type_record: ($) =>
			collection($, $.lbrace, $.rbrace, $.record_type_field, $.semicolon),
		type_tuple: ($) =>
			tuple($, $.lparen_hash, $.rparen, $.type_term, $.semicolon),
		type_wildcard: ($) => $.wildcard,
		parenthesized_type: ($) => seq($.lparen, $.type_expression, $.rparen),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.14: LITERALS & STRINGS
		// ─────────────────────────────────────────────────────────────────────────
		literal: ($) =>
			choice(
				$.int_literal,
				$.float_literal,
				$.char_literal,
				$.string,
				$.multiline_string,
			),

		float_literal: ($) =>
			token(choice(
				/[0-9][0-9_]*\.[0-9][0-9_]*(?:[eE][+-]?[0-9_]+)?(?:f32|f64)?/,
				/[0-9][0-9_]*\.(?:[eE][+-]?[0-9_]+)?(?:f32|f64)?/,
				/\.[0-9][0-9_]*(?:[eE][+-]?[0-9_]+)?(?:f32|f64)?/,
				/[0-9][0-9_]*[eE][+-]?[0-9_]+(?:f32|f64)?/,
			)),

		int_literal: ($) =>
			token(choice(
				/0[bB][01][01_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?/,
				/0[oO][0-7][0-7_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?/,
				/0[xX][0-9a-fA-F][0-9a-fA-F_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?/,
				/[0-9][0-9_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?/,
			)),

		string: ($) =>
			seq(
				$.quote,
				many(choice($.string_text, $.escape_sequence, $.interpolation)),
				$.quote,
			),
		multiline_string: ($) =>
			seq(
				$.triple_quote,
				many(
					choice(
						$.multiline_text,
						$.escape_sequence,
						$.interpolation,
						$.multiline_quote,
						$.multiline_double_quote,
					),
				),
				$.triple_quote,
			),
		char_literal: ($) =>
			token(
				choice(
					/'[^'\\]'/,
					/'\\(?:[nrt0\\'"bfv]|x[0-9A-Fa-f]+|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})'/,
				),
			),

		interpolation: ($) => seq($.interpolation_start, $.expression, $.rparen),
		interpolation_start: ($) => token(/\\\(/),

		string_text: ($) => token(/[^"\\\n]+/),
		multiline_text: ($) => token(/[^\\"]+/),
		multiline_quote: ($) => token(/"[^"]/),
		multiline_double_quote: ($) => token(/""[^"]/),

		escape_sequence: ($) => token(/\\(u\([0-9A-Fa-f]{1,8}\)|[\\'"ntrbfv])/),

		static_string: ($) =>
			seq(
				$.quote,
				many(choice($.static_string_text, $.escape_sequence)),
				$.quote,
			),
		static_string_text: ($) => token(/[^"\\\n]+/),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.15: COMMENTS
		// ─────────────────────────────────────────────────────────────────────────
		doc_comment: (_) =>
			token(prec(2, seq("///", /[^\n]*/, many(seq("\n", "///", /[^\n]*/))))),
		line_comment: (_) => token(prec(1, /\/\/[^\n]*/)),
		block_comment: (_) =>
			token(prec(-3, seq("</", many(choice(/[^/]/, /\/[^>]/)), "/>"))),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.16: IDENTIFIERS & OPERATORS
		// ─────────────────────────────────────────────────────────────────────────
		identifier: ($) => /(_*[a-z][a-zA-Z0-9_]*!?)/,
		tag_name: ($) => token(/(_*[A-Z][a-zA-Z0-9_]*)/),
		import_name: ($) => choice($.identifier, $.tag_name),
		name: ($) => choice($.identifier, $.tag_name),
		value_name: ($) => choice($.identifier, $.kw_self),
		long_identifier: ($) =>
			prec.left(
				seq(choice($.name, $.kw_self), many(seq($.module_sep, $.name))),
			),
		placeholder: ($) => token("__"),
		wildcard: ($) => "_",

		// Keywords
		kw_pub: () => "pub",
		kw_let: () => "let",
		kw_cert: () => "cert",
		kw_expect: () => "expect",
		kw_if: () => "if",
		kw_then: () => "then",
		kw_else: () => "else",
		kw_match: () => "match",
		kw_to: () => "to",
		kw_in: () => "in",
		kw_where: () => "where",
		kw_with: () => "with",
		kw_extend: () => "extend",
		kw_ability: () => "ability",
		kw_module: () => "module",
		kw_use: () => "use",
		kw_using: () => "using",
		kw_build: () => "build",
		kw_type: () => "type",
		kw_distinct: () => "distinct",
		kw_derives: () => "derives",
		kw_sig: () => "sig",
		kw_fn: () => "fn",
		kw_test: () => "test",
		kw_or: () => "or",
		kw_and: () => "and",
		kw_not: () => "not",
		kw_as: () => "as",
		kw_self: () => "self",
		kw_Self: () => "Self",

		// Punctuation
		lparen: () => "(",
		rparen: () => ")",
		lbracket: () => "[",
		rbracket: () => "]",
		lbrace: () => "{",
		rbrace: () => "}",
		lparen_hash: () => token("#("),
		lbracket_hash: () => token("#map["),

		quote: () => '"',
		triple_quote: () => token('"""'),

		comma: () => ",",
		colon: () => ":",
		equals: () => "=",
		semicolon: () => ";",
		dot: () => token.immediate("."),
		module_sep: () => token.immediate("::"),
		at_sign: () => token.immediate("@"),
		hash_sign: () => token.immediate("#"),

		pipe: () => token("|>"),
		pipe_bar: () => token("|"),

		or_op: ($) => $.kw_or,
		and_op: ($) => $.kw_and,

		plus: () => "+",
		minus: () => "-",
		star: () => "*",
		slash: () => "/",
		percent: () => "%",

		eq_op: () => "==",
		ne_op: () => "!=",
		le_op: () => "<=",
		ge_op: () => ">=",
		lt_op: () => "<",
		gt_op: () => ">",

		arrow: () => "->",
		fat_arrow: () => "=>",
		try_op: () => "?",
		possessive: () => token.immediate("'s"),
	},
});
