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

// --- Fundamental Block Patterns ---
function indented($, body) {
	return seq($.newline, $.indent, body, many($.newline), $.dedent);
}

// --- Block & Layout Helpers ---
function wrapped(open, close, body) {
	return seq(open, body, close);
}

function fileBody($, header, item) {
	return seq(
		many($.newline),
		opt(seq(header, many($.newline))),
		many(seq(item, many($.newline))),
	);
}

// --- Loose List Forms ---
function separated1(
	$,
	rule,
	separator,
	{ allow_newline_separator = true } = {},
) {
	const next = allow_newline_separator
		? choice(
			seq(separator, rule),
			seq(opt(separator), many1($.newline), rule),
		)
		: seq(separator, many($.newline), rule);

	return seq(
		rule,
		many(next),
		opt(separator),
	);
}

function layoutList1($, rule) {
	return seq(
		rule,
		many(seq(many($.newline), rule)),
	);
}

function inlineThenLayoutList1($, rule) {
	return seq(layoutList1($, rule), many($.newline));
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

function delimitedLoose($, open, close, body) {
	return seq(
		open,
		opt(seq(
			many($.newline),
			body,
			many($.newline),
		)),
		close,
	);
}

function looseSeparated2Plus($, rule, separator) {
	const next = choice(
		seq(separator, rule),
		seq(opt(separator), many1($.newline), rule),
	);

	return seq(
		rule,
		next,
		many(next),
		opt(separator),
	);
}

function collection($, open, close, item, separator) {
	return delimitedLoose(
		$,
		open,
		close,
		separated1($, item, separator),
	);
}

function tuple($, open, close, item, separator) {
	return delimitedLoose(
		$,
		open,
		close,
		looseSeparated2Plus($, field("element", item), separator),
	);
}

// --- Common Patterns ---
function attributePrefix($) {
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
							choice($.star, $.slash, $.kw_mod),
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
		$.doc_block_comment,
	],

	supertypes: ($) => [
		$.expression,
	],

	rules: {
		// ─────────────────────────────────────────────────────────────────────────
		// 3.1: TOP-LEVEL & SOURCE FILE
		// ─────────────────────────────────────────────────────────────────────────
		source_file: ($) => fileBody($, $.module_declaration, $.module_item),

		module_item: ($) =>
			choice(
				$.use_statement,
				$.declaration,
			),

		declaration: ($) =>
			choice(
				$.type_declaration,
				$.signature,
				$.value_declaration,
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
				field("module", $.path),
				opt(seq($.kw_as, field("alias", $.identifier))),
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
				field("name", $.path),
			),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.3: TYPE DECLARATIONS & VARIANTS
		// ─────────────────────────────────────────────────────────────────────────
		type_declaration: ($) =>
			seq(
				attributePrefix($),
				visibility_modifier($),
				$.kw_type,
				field("name", $.path),
				opt($.type_parameter_list),
				$.equals,
				field("value", choice($.variant_type_value, $.alias_type_value)),
				opt($.derives_clause),
			),
		derives_clause: ($) =>
			seq(
				$.kw_derives,
				choice(
					sep1(field("ability", $.type_term), $.comma),
					indented($, layoutList1($, field("ability", $.type_term))),
				),
			),
		variant_type_value: ($) => prec(2, $.type_variant_block),

		alias_type_value: ($) =>
			prec(
				1,
				seq(
					opt($.kw_distinct),
					$.type_body,
				),
			),

		type_parameter_list: ($) =>
			collection($, $.lparen, $.rparen, $.identifier, $.comma),
		type_variant_block: ($) => indented($, layoutList1($, $.type_variant)),

		type_variant: ($) =>
			seq(
				$.pipe_bar,
				field("name", $.identifier),
				opt(field("payload", $.type_variant_payload)),
			),

		type_variant_payload: ($) =>
			collection($, $.lparen, $.rparen, $.type_expression, $.comma),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.4: ANNOTATIONS & SIGNATURES
		// ─────────────────────────────────────────────────────────────────────────
		annotation: ($) =>
			seq(
				attributePrefix($),
				field("name", $.binding_name),
				$.colon,
				$.type_body,
				opt(field("constraints", $.constraint_clause)),
			),

		signature: ($) =>
			seq(
				attributePrefix($),
				visibility_modifier($),
				$.kw_sig,
				field("name", $.identifier),
				$.colon,
				$.type_body,
				opt(field("constraints", $.constraint_clause)),
			),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.5: VALUE BINDINGS & LET DECLARATIONS
		// ─────────────────────────────────────────────────────────────────────────
		value_declaration: ($) =>
			seq(
				attributePrefix($),
				visibility_modifier($),
				field("name", $.binding_name),
				opt(seq($.colon, $.type_body)),
				$.equals,
				$.value_slot,
			),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.6: ATTRIBUTES & METADATA
		// ─────────────────────────────────────────────────────────────────────────
		attribute: ($) =>
			seq(
				$.tilde,
				$.path,
				opt($.attribute_arguments_inline),
			),

		attribute_arguments_inline: ($) =>
			collection($, $.lparen, $.rparen, $.attribute_argument, $.comma),

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
				attributePrefix($),
				visibility_modifier($),
				$.kw_extend,
				field("type", $.type_term),
				$.kw_with,
				field("ability", $.path),
				field("methods", indented($, layoutList1($, $.implementation_method))),
			),

		implementation_method: ($) =>
			seq(
				field("name", $.identifier),
				opt(field("parameters", $.method_parameter_list)),
				$.fat_arrow,
				$.method_body,
			),

		method_parameter_list: ($) =>
			choice(
				sep1(field("param", $.binding_pattern), $.comma),
				indented(
					$,
					separated1($, field("param", $.binding_pattern), $.comma),
				),
			),
		ability_declaration: ($) =>
			seq(
				attributePrefix($),
				visibility_modifier($),
				$.kw_ability,
				field("name", $.path),
				opt($.type_parameter_list),
				field("methods", indented($, layoutList1($, $.annotation))),
			),

		expect_statement: ($) => seq($.kw_expect, field("value", $.expression)),

		test_declaration: ($) =>
			seq(
				attributePrefix($),
				$.kw_test,
				field("name", $.static_string),
				$.colon,
				field("body", indented($, layoutList1($, $.test_statement))),
			),

		test_statement: ($) =>
			choice(
				$.test_binding,
				$.test_value_declaration,
				$.expect_statement,
			),

		test_binding: ($) =>
			seq(
				$.kw_let,
				$.binding_core,
			),

		test_value_declaration: ($) =>
			seq(
				field("name", $.binding_name),
				opt(seq($.colon, $.type_body)),
				$.equals,
				$.value_slot,
			),

		binding_core: ($) =>
			seq(
				field("pattern", $.binding_pattern),
				opt(seq($.colon, $.type_body)),
				$.equals,
				$.value_slot,
			),

		binding_name: ($) => reserved("global", $.identifier),

		receiver_parameter: ($) => $.kw_self,

		// ─────────────────────────────────────────────────────────────────────────
		// 3.8: EXPRESSION HIERARCHY
		// ─────────────────────────────────────────────────────────────────────────
		expression: ($) => $.pipe_expression,

		arm_inline_expression: ($) => $.inline_expression,
		call_argument: ($) => $.pipe_expression,

		// Semantic wrapper rules for layout fields (slot-first naming)
		value_slot: ($) =>
			choice(
				field("value", $.expression),
				indented($, field("value", $.expression)),
			),

		match_arm_value: ($) =>
			choice(
				field("value", $.arm_inline_expression),
				indented($, field("value", $.expression)),
			),

		method_body: ($) =>
			choice(
				field("body", $.expression),
				indented($, field("body", $.expression)),
			),

		lambda_body: ($) =>
			choice(
				field("body", $.expression),
				indented($, field("body", $.expression)),
			),

		let_body: ($) =>
			choice(
				field("body", $.expression),
				indented($, field("body", $.expression)),
			),

		if_then_value: ($) =>
			choice(
				field("then_value", $.expression),
				indented($, field("then_value", $.expression)),
			),

		if_else_value: ($) =>
			choice(
				field("else_value", $.expression),
				indented($, field("else_value", $.expression)),
			),

		...buildExpressionLadder("", "postfix_expression"),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.9: POSTFIX EXPRESSIONS
		// ─────────────────────────────────────────────────────────────────────────

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

		postfix_suffix: ($) =>
			choice(
				field("indexing", $.index_suffix),
				$.field_suffix,
				$.method_suffix,
				$.try_op,
			),

		index_suffix: ($) =>
			seq($.lbracket, field("index", $.expression), $.rbracket),

		field_suffix: ($) => seq($.dot, field("field", $.field_name)),

		method_suffix: ($) =>
			seq(
				$.at_sign,
				field("method", $.identifier),
				opt($.method_qualification),
			),

		method_qualification: ($) =>
			seq(
				$.hash_sign,
				field("ability", $.path),
			),

		call_suffix: ($) =>
			prec.right(
				seq(
					$.kw_with,
					choice(
						sep1(field("arg", $.call_argument), $.comma),
						seq(
							many1($.newline),
							separated1($, field("arg", $.call_argument), $.comma, {
								allow_newline_separator: false,
							}),
						),
					),
				),
			),
		spread_element: ($) => seq($.rest_op, field("base", $.expression)),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.10: PRIMARY EXPRESSION FORMS
		// ─────────────────────────────────────────────────────────────────────────
		primary_expression: ($) =>
			choice(
				$.inline_expression,
				$.match_expression,
				$.if_expression,
				$.lambda_expression,
				$.let_expression,
			),

		constructed_record_expression: ($) =>
			prec(
				1,
				seq(
					field("constructor", $.path),
					field("body", $.record_body),
				),
			),

		inline_expression: ($) =>
			choice(
				$.constructed_record_expression,
				$.record_builder,
				$.literal,
				$.path,
				$.placeholder,
				$.list_expression,
				$.map_expression,
				$.record_expression,
				$.tuple_expression,
				$.parenthesized_expression,
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
				$.value_slot,
			),

		record_expression: ($) => $.record_body,

		//for applicative/product composition.
		record_builder: ($) =>
			seq($.kw_build, field("builder", $.path), $.builder_body),
		record_body: ($) =>
			collection($, $.lbrace, $.rbrace, $.record_field, $.semicolon),

		builder_body: ($) =>
			collection($, $.lbrace, $.rbrace, $.builder_field, $.semicolon),

		// Allow spread natively as a valid "field" inside records instead of complicating helpers
		record_field: ($) =>
			choice(
				seq(
					field("name", $.field_name),
					$.equals,
					$.value_slot,
				),
				$.spread_element,
			),

		builder_field: ($) =>
			seq(
				field("name", $.field_name),
				$.left_arrow,
				$.value_slot,
			),

		field_name: ($) => reserved("global", $.identifier),

		tuple_expression: ($) =>
			tuple($, $.lparen_hash, $.rparen, $.expression, $.semicolon),

		parenthesized_expression: ($) =>
			wrapped(
				$.lparen,
				$.rparen,
				choice(
					seq(many($.newline), field("value", $.expression), many($.newline)),
					indented($, field("value", $.expression)),
				),
			),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.11: BLOCK & CONTROL FLOW EXPRESSIONS
		// ─────────────────────────────────────────────────────────────────────────

		let_expression: ($) =>
			prec.right(seq(
				$.kw_let,
				choice(
					inlineThenLayoutList1($, $.binding_core),
					indented($, layoutList1($, $.binding_core)),
				),
				$.kw_in,
				$.let_body,
			)),

		match_expression: ($) =>
			prec.right(seq(
				$.kw_match,
				field("subject", $.pipe_expression),
				$.kw_to,
				indented($, layoutList1($, $.match_arm)),
			)),

		match_arm: ($) =>
			seq(
				field("pattern", $.pattern),
				$.arrow,
				$.match_arm_value,
			),

		lambda_expression: ($) =>
			prec.right(seq(
				$.kw_fn,
				choice(
					sep1(field("param", $.binding_pattern), $.comma),
					indented($, layoutList1($, field("param", $.binding_pattern))),
				),
				$.fat_arrow,
				$.lambda_body,
			)),

		if_expression: ($) =>
			prec.right(seq(
				$.kw_if,
				field("condition", $.expression),
				$.kw_then,
				$.if_then_value,
				$.kw_else,
				$.if_else_value,
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

		tag_pattern: ($) =>
			choice(
				$.nullary_tag_pattern,
				$.paren_tag_pattern,
			),

		nullary_tag_pattern: ($) => $.qualified_path,

		paren_tag_pattern: ($) =>
			seq(
				$.qualified_path,
				$.lparen,
				separated1($, $.pattern, $.comma),
				$.rparen,
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

		type_body: ($) =>
			choice(
				field("type", $.type_expression),
				indented($, field("type", $.type_expression)),
			),

		function_result: ($) =>
			choice(
				field("result", $.type_expression),
				indented($, field("result", $.type_expression)),
			),

		record_field_type: ($) =>
			choice(
				field("type", $.type_expression),
				indented($, field("type", $.type_expression)),
			),

		function_type_parameters: ($) =>
			separated1($, field("param", $.type_expression), $.comma),

		variadic_type: ($) => seq($.ellipsis, field("item", $.type_term)),
		ellipsis: ($) => token(prec(1, "...")),
		rest_op: ($) => "..",

		constraint_clause: ($) =>
			seq(
				$.kw_where,
				collection($, $.lbrace, $.rbrace, $.constraint_entry, $.comma),
			),

		constraint_entry: ($) =>
			seq(
				field("type_var", $.identifier),
				$.colon,
				field("constraint", $.constraint_sum),
			),

		constraint_sum: ($) =>
			prec.left(
				seq(
					field("ability", $.path),
					many(seq($.plus, field("ability", $.path))),
				),
			),

		type_term: ($) =>
			choice($.function_type, $.type_primary, $.type_tuple, $.type_record),

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
				$.arrow,
				$.function_result,
			),

		type_application: ($) => prec(1, seq($.path, $.type_argument_list)),

		self_type: ($) => $.kw_Self,

		type_primary: ($) =>
			choice(
				$.type_application,
				$.path,
				$.self_type,
				$.type_wildcard,
				$.parenthesized_type,
			),

		type_argument_list: ($) =>
			collection($, $.lbracket, $.rbracket, $.type_expression, $.comma),

		record_type_field: ($) =>
			seq(
				field("name", $.field_name),
				$.colon,
				$.record_field_type,
			),
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
				/[0-9][0-9_]*\.[0-9][0-9_]*(?:[eE][+-]?[0-9_]+)?(?:f32|f64)?%?/,
				/[0-9][0-9_]*\.(?:[eE][+-]?[0-9_]+)?(?:f32|f64)?%?/,
				/\.[0-9][0-9_]*(?:[eE][+-]?[0-9_]+)?(?:f32|f64)?%?/,
				/[0-9][0-9_]*[eE][+-]?[0-9_]+(?:f32|f64)?%?/,
			)),

		int_literal: ($) =>
			token(choice(
				/0[bB][01][01_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?%?/,
				/0[oO][0-7][0-7_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?%?/,
				/0[xX][0-9a-fA-F][0-9a-fA-F_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?%?/,
				/[0-9][0-9_]*(?:u8|u16|u32|u64|i8|i16|i32|i64)?%?/,
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
		doc_block_comment: (_) =>
			token(
				prec(
					2,
					seq(
						"<///",
						/[\s\S]*?/,
						"///>",
					),
				),
			),

		// ─────────────────────────────────────────────────────────────────────────
		// 3.16: IDENTIFIERS & OPERATORS
		// ─────────────────────────────────────────────────────────────────────────
		identifier: ($) => token(/[_\p{ID_Start}][\p{ID_Continue}]*!?/u),
		import_name: ($) => $.identifier,
		value_name: ($) => choice($.identifier, $.kw_self),

		path: ($) =>
			prec.left(
				seq(
					choice($.identifier, $.kw_self),
					many(seq($.module_sep, $.identifier)),
				),
			),

		qualified_path: ($) =>
			prec.left(
				seq(
					choice($.identifier, $.kw_self),
					$.module_sep,
					$.identifier,
					many(seq($.module_sep, $.identifier)),
				),
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
		kw_mod: () => "mod",
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
		tilde: () => token.immediate("~"),
		hash_sign: () => token.immediate("#"),

		pipe: () => token("|>"),
		pipe_bar: () => token("|"),

		or_op: ($) => $.kw_or,
		and_op: ($) => $.kw_and,

		plus: () => "+",
		minus: () => "-",
		star: () => "*",
		slash: () => "/",

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
	},
});
