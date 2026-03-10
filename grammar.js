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
	POSTFIX: 8,
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
		// ─────────────────────────────────────────────────────────────────────────────
		// 3.1: TOP-LEVEL & SOURCE FILE
		// ─────────────────────────────────────────────────────────────────────────────
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
					repeat(choice($.newline, $.module_item)),
				),
			),

		module_item: ($) =>
			choice(
				$.use_statement,
				$.documented_declaration,
			),

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

		module_declaration: ($) =>
			seq(
				$.kw_module,
				field("name", $.type_name),
			),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.3: TYPE DECLARATIONS & VARIANTS
		// ─────────────────────────────────────────────────────────────────────────────
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
						inline_or_block($, $.type_expression),
						$.type_variant_block,
					),
				),
			),

		type_parameter_list: ($) =>
			seq(
				$.lparen,
				commaSep1Trail($, $.type_variable, $.comma, $.newline),
				$.rparen,
			),

		type_variant_block: ($) =>
			indented_list($, $.type_variant, { at_least_one: true }),

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
		annotation: ($) =>
			seq(
				attribute_prefix($),
				field("name", $.binding_target),
				$.colon,
				field("type", inline_or_block($, $.type_expression)),
				optional(field("constraints", $.constraint_clause)),
			),

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
		attribute: ($) =>
			seq(
				"@",
				$.long_identifier,
				optional($.attribute_arguments_inline),
			),

		attribute_arguments_inline: ($) =>
			seq(
				$.lparen,
				optional(commaSepTrail($, $.attribute_argument, $.comma, $.newline)),
				$.rparen,
			),

		attribute_argument: ($) =>
			choice(
				$.expression,
				seq(field("name", $.identifier), $.colon, field("value", $.expression)),
			),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.7: IMPLEMENTATIONS & ABILITIES
		// ─────────────────────────────────────────────────────────────────────────────
		implementation: ($) =>
			seq(
				$.kw_extend,
				field("type", $.type_name),
				$.kw_with,
				field("ability", $.type_name),
				field(
					"methods",
					indented_list($, $.implementation_method, { at_least_one: true }),
				),
			),

		implementation_method: ($) =>
			seq(
				attribute_prefix($),
				field("name", $.identifier),
				repeat(field("param", $.identifier)),
				$.equals,
				field("value", inline_or_block_in_list($, $.expression)),
			),

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

		expect_statement: ($) => seq($.kw_expect, field("value", $.expression)),

		test_declaration: ($) =>
			seq(
				attribute_prefix($),
				$.kw_test,
				field("name", $.static_string),
				$.colon,
				field("body", indented_body($, $.expression)),
			),

		binding_target: ($) => $.identifier,

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.8: EXPRESSION HIERARCHY (Operators by Precedence)
		// ─────────────────────────────────────────────────────────────────────────────
		expression: ($) => $.pipe_expression,

		call_argument: ($) => $.bare_call_argument,

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

		compare_expression: ($) => compare_rule($, $.add_expression),

		add_expression: ($) => add_rule($, $.mul_expression),

		mul_expression: ($) => mul_rule($, $.unary_expression),

		unary_expression: ($) =>
			choice(
				prec.right(
					PREC.UNARY,
					seq(choice($.minus, $.kw_not, $.kw_cert), $.unary_expression),
				),
				$.postfix_expression,
			),

		// BARE CALL ARGUMENT EXPRESSIONS
		bare_call_argument: ($) => $.bare_or_expression,

		bare_or_expression: ($) => or_rule($, $.bare_and_expression),

		bare_and_expression: ($) => and_rule($, $.bare_compare_expression),

		bare_compare_expression: ($) => compare_rule($, $.bare_add_expression),

		bare_add_expression: ($) => add_rule($, $.bare_mul_expression),

		bare_mul_expression: ($) => mul_rule($, $.bare_unary_expression),

		bare_unary_expression: ($) =>
			choice(
				prec.right(
					PREC.UNARY,
					seq(choice($.minus, $.kw_not, $.kw_cert), $.bare_unary_expression),
				),
				$.bare_postfix_expression,
			),

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
				$.bare_projection_expression,
				$.bare_try_expression,
				$.bare_possessive_field_expression,
			),

		bare_projection_expression: ($) =>
			postfixOp(
				field("object", $.bare_postfix_expression),
				$.projection_suffix,
			),

		bare_try_expression: ($) =>
			postfixOp(
				field("value", $.bare_postfix_expression),
				$.try_op,
			),

		bare_possessive_field_expression: ($) =>
			postfixOp(
				field("object", $.bare_postfix_expression),
				$.possessive,
				field("field", $.field_name),
			),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.9: POSTFIX EXPRESSIONS (Calls, Fields, Try)
		// ─────────────────────────────────────────────────────────────────────────────
		postfix_expression: ($) =>
			choice(
				$.primary_expression,
				$.call_expression,
				$.field_expression,
				$.try_expression,
				$.possessive_field_expression,
			),

		call_expression: ($) =>
			prec.left(
				PREC.POSTFIX,
				seq(
					field("function", $.postfix_expression),
					field("arguments", $.call_suffix),
				),
			),

		field_expression: ($) =>
			prec.left(
				PREC.POSTFIX,
				seq(
					field("object", $.postfix_expression),
					$.dot,
					field("field", choice($.field_name, $.tuple_index)),
				),
			),

		try_expression: ($) =>
			prec.left(
				PREC.POSTFIX,
				seq(
					field("value", $.postfix_expression),
					$.try_op,
				),
			),

		possessive_field_expression: ($) =>
			prec.left(
				PREC.POSTFIX,
				seq(
					field("object", $.postfix_expression),
					$.possessive,
					field("field", $.field_name),
				),
			),

		spread_element: ($) => seq("..", field("base", $.expression)),

		call_suffix: ($) => with_call_suffix($),

		projection_suffix: ($) =>
			seq(
				$.dot,
				field("field", choice($.field_name, $.tuple_index)),
			),

		tuple_index: ($) => token(/[0-9]+/),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.10: PRIMARY EXPRESSION FORMS
		// ─────────────────────────────────────────────────────────────────────────────
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

		list_expression: ($) =>
			layoutBracket($, $.lbracket, $.rbracket, $.list_item),

		list_item: ($) =>
			choice(
				$.expression,
				$.spread_element,
			),

		record_body: ($) =>
			choice(
				singleLineRecordExpression($, $.record_field),
				multiLineRecordExpression($, $.record_field),
			),

		record_expression: ($) => $.record_body,

		record_builder: ($) =>
			seq(
				$.kw_build,
				field("builder", $.long_identifier),
				$.record_body,
			),

		field_name: ($) => $.identifier,

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

		tuple_expression: ($) => tuple_like($, $.expression),

		parenthesized_expression: ($) =>
			seq(
				$.lparen,
				field("value", $.expression),
				$.rparen,
			),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.11: BLOCK & CONTROL FLOW EXPRESSIONS
		// ─────────────────────────────────────────────────────────────────────────────
		block_expression: ($) =>
			seq(
				$.lparen,
				$.newline,
				$.indent,
				choice(
					field("value", $.expression),
					seq(
						$.let_binding,
						repeat(seq(repeat($.newline), $.let_binding)),
						repeat($.newline),
						$.kw_in,
						field("value", $.expression),
					),
				),
				repeat($.newline),
				$.dedent,
				$.rparen,
			),

		when_expression: ($) =>
			prec.right(seq(
				$.kw_when,
				field("subject", $.expression),
				$.kw_is,
				field("arms", indented_list($, $.when_arm, { at_least_one: true })),
			)),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.12: PATTERN MATCHING
		// ─────────────────────────────────────────────────────────────────────────────
		pattern: ($) =>
			seq(
				$.or_pattern,
				optional(seq($.kw_if, field("guard", $.expression))),
			),

		or_pattern: ($) =>
			prec.left(seq(
				$.as_pattern,
				repeat(seq($.pipe_bar, $.as_pattern)),
			)),

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

		wildcard_pattern: ($) => "_",

		simple_tag_argument_pattern: ($) =>
			choice(
				$.literal,
				$.wildcard_pattern,
				$.identifier,
			),

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

		rest_pattern: ($) =>
			seq(
				"..",
				field("binding", $.identifier),
			),

		tuple_pattern: ($) =>
			seq(
				$.lbrace_hash,
				$.pattern,
				$.comma,
				commaSepTrail($, $.pattern, $.comma, $.newline),
				$.rbrace,
			),

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

		record_pattern_field: ($) =>
			choice(
				seq($.field_name, $.colon, $.pattern),
				$.field_name,
			),

		arm_expression: ($) => inline_or_block_in_list($, $.expression),

		when_arm: ($) =>
			seq(
				field("pattern", $.pattern),
				$.arrow_op,
				field("value", $.arm_expression),
			),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.13: LAMBDA & SPECIAL EXPRESSIONS
		// ─────────────────────────────────────────────────────────────────────────────
		lambda_expression: ($) =>
			prec.right(seq(
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
			)),

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
				$.condition_projection_expression,
				$.condition_call_expression,
				$.condition_try_expression,
				$.condition_possessive_field_expression,
			),

		condition_projection_expression: ($) =>
			postfixOp(
				field("object", $.condition_postfix),
				$.projection_suffix,
			),

		condition_call_expression: ($) =>
			postfixOp(
				field("function", $.condition_postfix),
				field("arguments", $.call_suffix),
			),

		condition_try_expression: ($) =>
			postfixOp(
				field("value", $.condition_postfix),
				$.try_op,
			),

		condition_possessive_field_expression: ($) =>
			postfixOp(
				field("object", $.condition_postfix),
				$.possessive,
				field("field", $.field_name),
			),

		if_expression: ($) =>
			prec.right(seq(
				$.kw_if,
				field("condition", $.condition_expression),
				$.kw_then,
				field("then_value", $.if_branch),
				$.kw_else,
				field("else_value", $.if_branch),
			)),

		if_branch: ($) => inline_or_block($, $.expression),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.14: TYPE SYSTEM
		// ─────────────────────────────────────────────────────────────────────────────
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

		type_expression_no_comma: ($) =>
			prec.right(choice(
				seq(
					field("left", $.non_arrow_type),
					$.arrow_op,
					field("right", inline_or_block($, $.type_expression)),
				),
				$.non_arrow_type,
			)),

		type_function_params: ($) =>
			seq(
				field("first", $.non_arrow_type),
				repeat1(seq(
					$.comma,
					repeat($.newline),
					field("rest", $.non_arrow_type),
				)),
			),

		constraint_clause: ($) =>
			seq(
				$.kw_where,
				field("type_var", $.identifier),
				$.colon,
				field("constraint", $.non_arrow_type),
			),

		non_arrow_type: ($) =>
			choice(
				$.function_type,
				$.type_primary,
				$.type_tuple,
				$.type_record,
			),

		function_type: ($) =>
			seq(
				$.kw_fn,
				$.lparen,
				$.type_expression,
				$.rparen,
			),

		type_application: ($) => seq($.type_name, $.type_argument_list),

		type_variable: ($) => $.identifier,

		type_primary: ($) =>
			choice(
				$.type_application,
				$.type_name,
				$.type_variable,
				alias("_", $.type_wildcard),
				alias("*", $.type_star),
				$.parenthesized_type,
			),

		type_name: ($) => dotted1($, $.tag_name, $.tag_name),

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

		record_type_field: ($) =>
			seq(
				$.field_name,
				$.colon,
				inline_or_block($, $.type_expression_no_comma),
			),

		type_tuple: ($) => tuple_like($, $.non_arrow_type),

		parenthesized_type: ($) => seq($.lparen, $.type_expression, $.rparen),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.15: LITERALS & STRING FORMS
		// ─────────────────────────────────────────────────────────────────────────────
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
				repeat(choice(
					$.string_text,
					$.escape_sequence,
					$.interpolation,
				)),
				$.quote,
			),

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

		char_literal: ($) =>
			seq(
				$.single_quote,
				choice(
					$.escape_sequence,
					/[^'\\]/,
				),
				$.single_quote,
			),

		interpolation: ($) =>
			seq(
				$.interpolation_start,
				$.expression,
				$.rparen,
			),

		interpolation_start: ($) => token(/\\\(/),

		string_text: ($) => token(/[^"\\\n]+/),

		multiline_text: ($) => token(/[^\\"]+/),
		multiline_quote: ($) => token(/"[^"]/),
		multiline_double_quote: ($) => token(/""[^"]/),

		escape_sequence: ($) => token(/\\(u\([0-9A-Fa-f]{1,8}\)|[\\'"ntrbfv])/),

		static_string: ($) =>
			seq(
				'"',
				repeat(choice(
					$.static_string_text,
					$.escape_sequence,
				)),
				'"',
			),

		static_string_text: ($) => token(/[^"\\\n]+/),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.16: COMMENTS
		// ─────────────────────────────────────────────────────────────────────────────
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
		identifier: ($) => token(prec(1, /(_*[a-z][a-zA-Z0-9_]*!?)/)),

		tag_name: ($) => token(/(_*[A-Z][a-zA-Z0-9_]*)/),

		import_name: ($) => choice($.identifier, $.tag_name),

		name: ($) => choice($.identifier, $.tag_name),

		long_identifier: ($) => prec.left(dotted1($, $.name, $.name)),

		placeholder: ($) => token("__"),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.18: OPERATORS & PUNCTUATION
		// ─────────────────────────────────────────────────────────────────────────────
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
		kw_extend: kw("extend"),
		kw_ability: kw("ability"),
		kw_module: kw("module"),
		kw_use: kw("use"),
		kw_using: kw("using"),
		kw_build: kw("build"),
		kw_type: kw("type"),
		kw_sig: kw("sig"),
		kw_fn: kw("fn"),
		kw_test: kw("test"),
		kw_or: kw("or"),
		kw_and: kw("and"),
		kw_not: kw("not"),
		kw_as: kw("as"),

		lparen: ($) => "(",
		rparen: ($) => ")",
		lbracket: ($) => "[",
		rbracket: ($) => "]",
		lbrace: ($) => "{",
		rbrace: ($) => "}",
		lbrace_hash: ($) => token("#{"),

		quote: ($) => '"',
		triple_quote: ($) => token('"""'),
		single_quote: ($) => "'",

		comma: ($) => ",",
		colon: ($) => ":",
		equals: op(2, "="),
		dot: ($) => token.immediate("."),

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

		eq_op: op(3, "=="),
		ne_op: op(3, "!="),
		le_op: op(4, "<="),
		ge_op: op(4, ">="),
		lt_op: op(3, "<"),
		gt_op: op(3, ">"),

		arrow_op: ($) => "->",
		try_op: ($) => "?",
		possessive: ($) => token.immediate("'s"),

		type_record: ($) =>
			layoutBracket($, $.lbrace, $.rbrace, $.record_type_field),

		type_wildcard: ($) => "_",
		type_star: ($) => "*",
	},
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4: HELPER FUNCTIONS
// ═════════════════════════════════════════════════════════════════════════════

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

function indented_body($, rule) {
	return seq(
		$.newline,
		$.indent,
		rule,
		repeat($.newline),
		$.dedent,
	);
}

function indented_body_in_list($, rule) {
	return seq(
		$.newline,
		$.indent,
		rule,
		$.newline,
		$.dedent,
	);
}

function indented_list($, item, { at_least_one = false } = {}) {
	const body = at_least_one
		? seq(
			item,
			repeat(choice($.newline, item))
		)
		: choice(
			seq(item, repeat(choice($.newline, item))),
			repeat($.newline)
		);

	return seq(
		$.newline,
		$.indent,
		body,
		$.dedent,
	);
}

function inline_or_block($, rule) {
	return choice(
		rule,
		indented_body($, rule),
	);
}

function inline_or_block_in_list($, rule) {
	return choice(
		rule,
		indented_body_in_list($, rule),
	);
}

function dotted1($, head, tail) {
	return seq(
		head,
		repeat(seq($.dot, tail)),
	);
}

function attribute_prefix($) {
	return repeat(seq($.attribute, $.newline));
}

function left_assoc_chain(precValue, operand, operator) {
	return prec.left(
		precValue,
		seq(
			operand,
			repeat(seq(operator, operand)),
		),
	);
}

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

function postfixOp(...pattern) {
	return prec.left(PREC.POSTFIX, seq(...pattern));
}

function tuple_like($, itemRule) {
	return choice(
		seq(
			$.lbrace_hash,
			field("first", itemRule),
			$.comma,
			field("second", itemRule),
			repeat(seq($.comma, field("rest", itemRule))),
			optional($.comma),
			$.rbrace,
		),
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

function with_call_suffix($) {
	return choice(
		prec.right(seq(
			$.kw_with,
			field("arg", $.call_argument),
		)),
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
		repeat(seq(
			commaToken,
			repeat(sepToken),
			rule,
		)),
		optional(seq(repeat(sepToken), commaToken)),
	);
}

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

function multiLineRecordExpression($, field) {
	return seq(
		$.lbrace,
		$.newline,
		$.indent,
		optional(choice(
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
