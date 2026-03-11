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

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2: GRAMMAR METADATA & CONFIGURATION
// ═════════════════════════════════════════════════════════════════════════════

// Helper: Generate operator precedence ladder (regular and restricted variants)
function buildOperatorLadder(prefix, postfixRuleName) {
	return {
		[`${prefix}pipe_expression`]: ($) =>
			prec.left(
				PREC.PIPE,
				seq(
					$[`${prefix}or_expression`],
					repeat(seq($.pipe, $[`${prefix}or_expression`])),
				),
			),
		[`${prefix}or_expression`]: ($) => or_rule($, $[`${prefix}and_expression`]),
		[`${prefix}and_expression`]: ($) =>
			and_rule($, $[`${prefix}compare_expression`]),
		[`${prefix}compare_expression`]: ($) =>
			compare_rule($, $[`${prefix}add_expression`]),
		[`${prefix}add_expression`]: ($) =>
			add_rule($, $[`${prefix}mul_expression`]),
		[`${prefix}mul_expression`]: ($) =>
			mul_rule($, $[`${prefix}unary_expression`]),
		[`${prefix}unary_expression`]: ($) =>
			choice(
				prec.right(
					PREC.UNARY,
					seq(
						choice($.minus, $.kw_not, $.kw_cert),
						$[`${prefix}unary_expression`],
					),
				),
				$[postfixRuleName],
			),
	};
}

module.exports = grammar({
	name: "kippy",

	// tree-sitter uses this for keyword extraction and error recovery.
	word: ($) => $.identifier,

	// Reserved word sets for keyword vs identifier disambiguation.
	// Using tree-sitter's reserved mechanism instead of lexical precedence.
	reserved: {
		global: ($) => [
			$.kw_pub,
			$.kw_let,
			$.kw_cert,
			$.kw_expect,
			$.kw_if,
			$.kw_then,
			$.kw_else,
			$.kw_when,
			$.kw_is,
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
			$.kw_sig,
			$.kw_fn,
			$.kw_test,
			$.kw_or,
			$.kw_and,
			$.kw_not,
			$.kw_as,
			$.kw_self,
		],
	},

	// layout-sensitive tokens are provided externally by the scanner.
	externals: ($) => [
		$.newline,
		$.indent,
		$.dedent,
	],

	// whitespace and comments are trivia (ignored by parser).
	// Doc comments are also trivia; attachment to declarations is handled by subsequent passes.
	extras: ($) => [
		/[ \t\r\f]+/,
		$.line_comment,
		$.block_comment,
		$.doc_comment,
	],

	supertypes: ($) => [
		$.expression,
	],

	// ═════════════════════════════════════════════════════════════════════════════
	// SECTION 3: GRAMMAR RULES
	// ═════════════════════════════════════════════════════════════════════════════
	rules: {
		// ─────────────────────────────────────────────────────────────────────────────
		// 3.1: TOP-LEVEL & SOURCE FILE
		// ─────────────────────────────────────────────────────────────────────────────
		source_file: ($) =>
			seq(
				repeat($.newline),
				optional(seq(
					$.module_declaration,
					repeat1($.newline),
				)),
				repeat(seq(
					$.module_item,
					repeat($.newline),
				)),
			),

		module_item: ($) =>
			choice(
				$.use_statement,
				$.documented_declaration,
			),

		documented_declaration: ($) =>
			choice(
				$.type_declaration,
				$.signature,
				$.let_binding,
				$.ability_declaration,
				$.test_declaration,
				$.expect_statement,
				$.implementation,
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
						seq(
							optional($.kw_distinct),
							inline_or_block($, $.type_expression),
						),
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
				optional(seq(
					$.kw_with,
					field("param", $.identifier),
					repeat(seq(
						$.comma,
						field("param", $.identifier),
					)),
				)),
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
				$.hash_sign,
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
				seq(
					field("name", $.identifier),
					$.equals,
					field("value", $.expression),
				),
			),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.7: IMPLEMENTATIONS & ABILITIES
		// ─────────────────────────────────────────────────────────────────────────────
		implementation: ($) =>
			seq(
				$.kw_extend,
				field("type", $.non_arrow_type),
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
				optional(field("receiver", $.receiver_parameter)),
				repeat(field("param", $.identifier)),
				$.equals,
				field("value", inline_or_block($, $.expression)),
			),

		ability_declaration: ($) =>
			seq(
				attribute_prefix($),
				$.kw_ability,
				field("name", $.type_name),
				optional($.type_parameter_list),
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
				field("body", block_body($, $.expression)),
			),

		binding_target: ($) => reserved("global", $.identifier),

		receiver_parameter: ($) => $.kw_self,

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.8: EXPRESSION HIERARCHY (Operators by Precedence)
		// ─────────────────────────────────────────────────────────────────────────────
		expression: ($) => $.pipe_expression,

		call_argument: ($) => $["restricted_pipe_expression"],

		pipe_expression: ($) =>
			prec.left(
				PREC.PIPE,
				seq(
					$.or_expression,
					repeat(seq($.pipe, $.or_expression)),
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

		restricted_postfix_expression: ($) =>
			prec.left(
				PREC.POSTFIX,
				seq(
					$.primary_expression,
					repeat($.restricted_postfix_suffix),
				),
			),

		index_suffix: ($) =>
			seq(
				$.lbracket,
				field("index", $.expression),
				$.rbracket,
			),

		method_suffix: ($) =>
			seq(
				$.dot,
				field("method", $.identifier),
			),

		qualified_method_suffix: ($) =>
			seq(
				$.at_sign,
				field("ability", $.tag_name),
				$.dot,
				field("method", $.identifier),
			),

		restricted_postfix_suffix: ($) => postfix_suffixes($, { allowCall: false }),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.9: POSTFIX EXPRESSIONS (Calls, Fields, Try)
		// ─────────────────────────────────────────────────────────────────────────────
		// Postfix expressions: base + repeating operators (no indirect recursion)
		postfix_expression: ($) =>
			prec.left(
				PREC.POSTFIX,
				seq(
					$.primary_expression,
					repeat($.postfix_suffix),
				),
			),

		postfix_suffix: ($) => postfix_suffixes($, { allowCall: true }),

		spread_element: ($) => seq("..", field("base", $.expression)),

		call_suffix: ($) => with_call_suffix($),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.10: PRIMARY EXPRESSION FORMS
		// ─────────────────────────────────────────────────────────────────────────────
		// ─────────────────────────────────────────────────────────────────────────────
		// 3.9A: INLINE VS BLOCK EXPRESSION HIERARCHY
		// ─────────────────────────────────────────────────────────────────────────────
		// Inline expressions: atoms and structures without layout
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

		// Block expressions: layout-based constructs (when, if, lambda, let-in blocks)
		block_expression: ($) =>
			choice(
				$.when_expression,
				$.if_expression,
				$.lambda_expression,
				$.let_block_expression,
			),

		primary_expression: ($) =>
			choice(
				$.inline_expression,
				$.block_expression,
			),

		list_expression: ($) =>
			layoutBracketWithSep($, $.lbracket, $.rbracket, $.list_item, $.semicolon),

		list_item: ($) =>
			choice(
				$.expression,
				$.spread_element,
			),

		record_body: ($) =>
			record_like($, $.record_field, {
				allowSpread: true,
				spreadRule: $.spread_element,
			}),

		record_expression: ($) => $.record_body,

		record_builder: ($) =>
			seq(
				$.kw_build,
				field("builder", $.long_identifier),
				$.record_body,
			),

		map_expression: ($) =>
			layoutBracketWithSep(
				$,
				$.lbracket_hash,
				$.rbracket,
				$.map_entry,
				$.semicolon,
			),

		map_entry: ($) =>
			seq(
				field("key", $.expression),
				$.thick_arrow,
				field("value", $.expression),
			),

		field_name: ($) => reserved("global", $.identifier),

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
				$.equals,
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
		let_block_expression: ($) =>
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

		when_expression: ($) =>
			prec.right(seq(
				$.kw_when,
				field("subject", $.pipe_expression),
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
						repeat(seq($.semicolon, $.pattern)),
						optional(seq($.semicolon, $.rest_pattern)),
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
				$.semicolon,
				commaSepTrail($, $.pattern, $.semicolon, $.newline),
				$.rbrace,
			),

		record_pattern: ($) =>
			seq(
				$.lbrace,
				optional(choice(
					seq(
						$.record_pattern_field,
						repeat(seq($.semicolon, $.record_pattern_field)),
						optional(seq($.semicolon, "..")),
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

		arm_expression: ($) => inline_or_block($, $.expression),

		when_arm: ($) =>
			seq(
				field("pattern", $.pattern),
				$.arrow,
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

		if_expression: ($) =>
			prec.right(seq(
				$.kw_if,
				field("condition", $.expression),
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
					field("left", $.function_type_left),
					$.arrow,
					field("right", inline_or_block($, $.type_expression)),
				),
				$.non_arrow_type,
				$.variadic_type,
			)),

		type_expression_no_comma: ($) =>
			prec.right(choice(
				seq(
					field("left", choice($.non_arrow_type, $.variadic_type)),
					$.arrow,
					field("right", inline_or_block($, $.type_expression)),
				),
				$.non_arrow_type,
				$.variadic_type,
			)),

		function_type_left: ($) =>
			choice(
				$.variadic_type,
				$.non_arrow_type,
				seq(
					field("first", $.non_arrow_type),
					repeat1(seq(
						$.comma,
						repeat($.newline),
						field("rest", $.non_arrow_type),
					)),
					optional(seq(
						$.comma,
						repeat($.newline),
						field("variadic", $.variadic_type),
					)),
				),
				seq(
					field("first", $.non_arrow_type),
					$.comma,
					repeat($.newline),
					field("variadic", $.variadic_type),
				),
			),

		variadic_type: ($) =>
			seq(
				$.ellipsis,
				field("item", $.non_arrow_type),
			),

		ellipsis: ($) => token(prec(1, "...")),

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

		type_variable: ($) => reserved("global", $.identifier),

		type_primary: ($) =>
			choice(
				$.type_application,
				$.type_name,
				$.type_variable,
				$.type_wildcard,
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
					optional($.comma),
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
		identifier: ($) => /(_*[a-z][a-zA-Z0-9_]*!?)/,

		tag_name: ($) => token(/(_*[A-Z][a-zA-Z0-9_]*)/),

		import_name: ($) => choice($.identifier, $.tag_name),

		name: ($) => choice($.identifier, $.tag_name),

		value_name: ($) => choice($.identifier, $.kw_self),

		long_identifier: ($) => prec.left(dotted1($, $.value_name, $.name)),

		placeholder: ($) => token("__"),

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.18: OPERATORS & PUNCTUATION
		// ─────────────────────────────────────────────────────────────────────────────
		kw_pub: ($) => "pub",
		kw_let: ($) => "let",
		kw_cert: ($) => "cert",
		kw_expect: ($) => "expect",
		kw_if: ($) => "if",
		kw_then: ($) => "then",
		kw_else: ($) => "else",
		kw_when: ($) => "when",
		kw_is: ($) => "is",
		kw_in: ($) => "in",
		kw_where: ($) => "where",
		kw_with: ($) => "with",
		kw_extend: ($) => "extend",
		kw_ability: ($) => "ability",
		kw_module: ($) => "module",
		kw_use: ($) => "use",
		kw_using: ($) => "using",
		kw_build: ($) => "build",
		kw_type: ($) => "type",
		kw_distinct: ($) => "distinct",
		kw_sig: ($) => "sig",
		kw_fn: ($) => "fn",
		kw_test: ($) => "test",
		kw_or: ($) => "or",
		kw_and: ($) => "and",
		kw_not: ($) => "not",
		kw_as: ($) => "as",
		kw_self: ($) => "self",

		lparen: ($) => "(",
		rparen: ($) => ")",
		lbracket: ($) => "[",
		rbracket: ($) => "]",
		lbrace: ($) => "{",
		rbrace: ($) => "}",
		lbrace_hash: ($) => token("#{"),
		lbracket_hash: ($) => token("#["),

		quote: ($) => '"',
		triple_quote: ($) => token('"""'),
		single_quote: ($) => "'",

		comma: ($) => ",",
		colon: ($) => ":",
		equals: ($) => "=",
		semicolon: ($) => ";",
		dot: ($) => token.immediate("."),
		at_sign: ($) => token.immediate("@"),
		hash_sign: ($) => token.immediate("#"),

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

		eq_op: ($) => "==",
		ne_op: ($) => "!=",
		le_op: ($) => "<=",
		ge_op: ($) => ">=",
		lt_op: ($) => "<",
		gt_op: ($) => ">",

		arrow: ($) => "->",
		thick_arrow: ($) => "=>",
		try_op: ($) => "?",
		possessive: ($) => token.immediate("'s"),

		type_record: ($) => record_like($, $.record_type_field, {}),

		type_wildcard: ($) => "_",

		// ─────────────────────────────────────────────────────────────────────────────
		// 3.8A: RESTRICTED EXPRESSION HIERARCHY FOR CALL ARGUMENTS (Generated)
		// ─────────────────────────────────────────────────────────────────────────────
		// Call arguments use a restricted expression ladder that prevents bare nested calls.
		// This forces users to parenthesize nested function calls: f with (g with x)
		// instead of f with g with x. Parenthesized expressions can contain any expression,
		// including calls, so full expressivity is maintained.
		// These rules are generated from buildOperatorLadder() to eliminate duplication.
		...buildOperatorLadder("restricted_", "restricted_postfix_expression"),
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

function block_body($, rule) {
	return seq(
		$.newline,
		$.indent,
		rule,
		repeat($.newline),
		$.dedent,
	);
}

function indented_list($, item, { at_least_one = false } = {}) {
	const body = at_least_one
		? seq(
			item,
			repeat(seq($.newline, item)),
		)
		: choice(
			seq(item, repeat(seq($.newline, item))),
			repeat($.newline),
		);

	return seq(
		$.newline,
		$.indent,
		body,
		$.dedent,
	);
}

function inline_or_block($, rule) {
	return choice(rule, block_body($, rule));
}

function postfix_suffixes($, { allowCall }) {
	const parts = [
		field("indexing", $.index_suffix),
		$.method_suffix,
		$.qualified_method_suffix,
		$.try_op,
		seq($.possessive, field("field", $.field_name)),
	];

	if (allowCall) {
		parts.unshift(field("arguments", $.call_suffix));
	}

	return choice(...parts);
}

function dotted1($, head, tail) {
	return seq(
		head,
		repeat(seq($.dot, tail)),
	);
}

function attribute_prefix($) {
	return repeat(seq($.attribute, optional($.newline)));
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

function tuple_like($, itemRule) {
	return choice(
		seq(
			$.lbrace_hash,
			field("first", itemRule),
			$.semicolon,
			field("second", itemRule),
			repeat(seq($.semicolon, field("rest", itemRule))),
			optional($.semicolon),
			$.rbrace,
		),
		seq(
			$.lbrace_hash,
			$.newline,
			$.indent,
			field("first", itemRule),
			optional($.semicolon),
			repeat1($.newline),
			field("second", itemRule),
			repeat(seq(
				optional($.semicolon),
				repeat1($.newline),
				field("rest", itemRule),
			)),
			optional($.semicolon),
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
			repeat(seq(
				$.comma,
				repeat($.newline),
				field("arg", $.call_argument),
			)),
			optional($.comma),
		)),
		seq(
			$.kw_with,
			$.newline,
			$.indent,
			field("arg", $.call_argument),
			repeat(seq(
				$.comma,
				$.newline,
				field("arg", $.call_argument),
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

function layoutBracketWithSep($, open, close, item, sep) {
	return choice(
		singleLineBracket(open, sep, item, close),
		multiLineBracket($, open, sep, item, close),
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
			optional(commaToken),
			repeat1(sepToken),
			rule,
		)),
		optional(seq(repeat(sepToken), commaToken)),
	);
}

function record_like($, fieldRule, { allowSpread = false, spreadRule = null }) {
	return choice(
		seq(
			$.lbrace,
			optional(
				allowSpread
					? choice(
						seq(
							fieldRule,
							repeat(seq($.semicolon, fieldRule)),
							optional(seq($.semicolon, spreadRule)),
						),
						spreadRule,
					)
					: seq(
						fieldRule,
						repeat(seq($.semicolon, fieldRule)),
						optional($.semicolon),
					),
			),
			$.rbrace,
		),
		seq(
			$.lbrace,
			$.newline,
			$.indent,
			optional(
				allowSpread
					? choice(
						seq(
							fieldRule,
							repeat(seq(
								optional($.semicolon),
								repeat1($.newline),
								fieldRule,
							)),
							optional(seq(
								optional($.semicolon),
								repeat1($.newline),
								spreadRule,
							)),
							optional($.semicolon),
						),
						seq(spreadRule, optional($.semicolon)),
					)
					: seq(
						fieldRule,
						repeat(seq(
							optional($.semicolon),
							repeat1($.newline),
							fieldRule,
						)),
						optional($.semicolon),
					),
			),
			repeat($.newline),
			$.dedent,
			$.rbrace,
		),
	);
}
