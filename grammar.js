const PREC = {
	PIPE: 1,
	MATCH: 2,
	OR: 3,
	AND: 4,
	COMPARE: 5,
	ADD: 6,
	MUL: 7,
	UNARY: 8,
	POSTFIX: 9,
};

const KEYWORDS = [
	"pub",
	"let",
	"rec",
	"alias",
	"distinct",
	"tag",
	"record",
	"choice",
	"expect",
	"if",
	"then",
	"else",
	"to",
	"in",
	"where",
	"with",
	"shape",
	"module",
	"use",
	"build",
	"type",
	"fit",
	"derive",
	"sig",
	"fn",
	"test",
	"or",
	"and",
	"not",
	"mod",
	"as",
	"self",
	"Self",
];

const DEC_DIGITS = "(?:[0-9]|[0-9][0-9_]*[0-9])";
const HEX_DIGITS = "(?:[0-9a-fA-F]|[0-9a-fA-F][0-9a-fA-F_]*[0-9a-fA-F])";
const OCT_DIGITS = "(?:[0-7]|[0-7][0-7_]*[0-7])";
const BIN_DIGITS = "(?:[01]|[01][01_]*[01])";
const INT_SUFFIX = "(?:U8|U16|U32|U64|I8|I16|I32|I64)?";
const FLOAT_SUFFIX = "(?:F32|F64)?";
const PERCENT = "%";
const EXPONENT = "(?:[eE][+-]?(?:[0-9]|[0-9][0-9_]*[0-9]))";
const CHAR_ESCAPE =
	`(?:[nrt0\\\\'"bfv]|x[0-9A-Fa-f]{2}|u\\([0-9A-Fa-f]{1,8}\\)|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})`;
const LINE_SPLICE = "\\r?\\n[ \\t]*";
const STRING_ESCAPE =
	`(?:u\\([0-9A-Fa-f]{1,8}\\)|x[0-9A-Fa-f]{2}|[\\\\'"ntrbfv]|${LINE_SPLICE})`;

const opt = optional;
const many = repeat;
const many1 = repeat1;

function sep1(rule, separator) {
	return seq(rule, many(seq(separator, rule)));
}

function separated1(
	$,
	rule,
	separator,
	{ optional_separator = true } = {},
) {
	if (optional_separator) {
		return seq(rule, many(seq(opt(separator), rule)), opt(separator));
	}
	return seq(rule, many(seq(separator, rule)), opt(separator));
}

function delimited($, open, close, interior) {
	return seq(open, opt(interior), close);
}

function layoutExpr($, name = "value") {
	return field(name, $.expression);
}

function layoutType($, name = "type") {
	return field(name, $.type_expression);
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

function looseSeparated2Plus(
	$,
	rule,
	separator,
	{ optional_separator = true } = {},
) {
	void optional_separator;
	return seq(rule, separator, rule, many(seq(separator, rule)), opt(separator));
}

function collection(
	$,
	open,
	close,
	item,
	separator,
	{ optional_separator = true } = {},
) {
	return delimited(
		$,
		open,
		close,
		separated1($, item, separator, { optional_separator }),
	);
}

function tuple(
	$,
	open,
	close,
	item,
	separator,
	{ optional_separator = true } = {},
) {
	return delimited(
		$,
		open,
		close,
		looseSeparated2Plus($, field("element", item), separator, {
			optional_separator,
		}),
	);
}

function flexCollection(
	$,
	open,
	close,
	rule,
	separator,
	{ optional_separator = true } = {},
) {
	const body = seq(
		rule,
		many(seq(optional_separator ? opt(separator) : separator, rule)),
		opt(separator),
	);
	return seq(open, opt(body), close);
}

function bracedCollection($, rule, separator) {
	return flexCollection($, $.lbrace, $.rbrace, rule, separator);
}

function withPayloads($, nameRule, payloadRule) {
	return seq(
		nameRule,
		$.kw_with,
		field("payload", payloadRule),
		many(seq($.comma, field("payload", payloadRule))),
	);
}

function parameterList($, paramRule) {
	return seq(
		field("param", paramRule),
		many(seq($.comma, field("param", paramRule))),
		opt($.comma),
	);
}

function bareBinding($, nameRule) {
	return seq(
		field("name", nameRule),
		opt(seq($.colon, field("type_ann", $.type_body))),
		$.equals,
		$.value_slot,
	);
}

function attributePrefix($) {
	return many(field("attribute", $.attribute));
}

module.exports = grammar({
	name: "kippy",
	word: ($) => $.identifier,
	reserved: { global: ($) => KEYWORDS.map((k) => $[`kw_${k}`]) },
	extras: (
		$,
	) => [
		new RustRegex("[ \\t\\r\\f]+"),
		new RustRegex("\\r?\\n"),
		$.line_comment,
		$.block_comment,
	],
	supertypes: ($) => [$.expression],
	inline: (
		$,
	) => [
		$.value_slot,
		$.match_arm_value,
		$.method_body,
		$.lambda_body,
		$.let_body,
		$.if_then_value,
		$.if_else_value,
		$._declaration_inner,
		$._top_level_item,
	],

	rules: {
		source_file: ($) => fileBody($, $.module_declaration, $.module_item),

		// === Top-level items ===
		module_item: ($) =>
			seq(
				attributePrefix($),
				$._top_level_item,
			),
		_top_level_item: ($) => choice($.use_statement, $.declaration),

		declaration: ($) =>
			seq(
				field("visibility", opt($.kw_pub)),
				$._declaration_inner,
			),
		_declaration_inner: ($) =>
			choice(
				$.alias_declaration,
				$.distinct_declaration,
				$.tag_declaration,
				$.record_declaration,
				$.choice_declaration,
				$.derive_declaration,
				$.signature,
				$.value_declaration,
				$.shape_declaration,
				$.test_declaration,
				$.implementation,
			),

		// === use_statement (no visibility) ===
		use_statement: ($) =>
			seq(
				$.kw_use,
				field("module", $.path),
				opt(seq($.kw_as, field("alias", $.identifier))),
				opt(seq($.dot, field("imports", $.import_set))),
			),
		import_set: ($) =>
			seq(
				$.lbrace,
				opt(
					separated1($, $.import_item, $.comma, {
						optional_separator: false,
					}),
				),
				$.rbrace,
			),
		import_item: ($) =>
			seq(
				field("name", $.identifier),
				opt(seq($.kw_as, field("alias", $.identifier))),
			),
		module_declaration: ($) => seq($.kw_module, field("name", $.path)),

		// === Type/value declarations (attributes + visibility hoisted out) ===
		alias_declaration: ($) =>
			seq(
				$.kw_alias,
				field("name", $.binding_name),
				$.equals,
				field("body", $.type_expression),
			),
		distinct_declaration: ($) =>
			seq(
				$.kw_distinct,
				field("name", $.binding_name),
				opt(field("type_params", $.type_parameter_list)),
				opt(seq($.equals, field("body", $.type_expression))),
			),
		tag_declaration: ($) =>
			seq(
				$.kw_tag,
				field("name", $.binding_name),
				opt(field("type_params", $.type_parameter_list)),
			),
		record_declaration: ($) =>
			seq(
				$.kw_record,
				field("name", $.binding_name),
				opt(field("type_params", $.type_parameter_list)),
				field("body", $.record_type),
			),
		choice_declaration: ($) =>
			seq(
				$.kw_choice,
				field("name", $.binding_name),
				opt(field("type_params", $.type_parameter_list)),
				field("body", bracedCollection($, $.choice_variant, $.semicolon)),
			),
		choice_variant: ($) =>
			seq(
				attributePrefix($),
				field("name", $.identifier),
				opt(
					choice(
						seq(
							$.kw_with,
							field("payload", $.type_expression),
							many(seq($.comma, field("payload", $.type_expression))),
						),
						field("payload", $.record_type),
					),
				),
			),

		type_parameter_list: ($) =>
			collection($, $.lbracket, $.rbracket, $.identifier, $.comma, {
				optional_separator: false,
			}),
		shape_method: ($) =>
			seq(
				attributePrefix($),
				field("name", $.binding_name),
				$.colon,
				field("type_ann", $.type_body),
				opt(field("default", $.method_default)),
				opt(field("constraints", $.constraint_clause)),
			),
		method_default: ($) => seq($.equals, $.value_slot),
		signature: ($) =>
			seq(
				$.kw_sig,
				field("name", $.identifier),
				$.colon,
				field("type_ann", $.type_body),
				opt(field("constraints", $.constraint_clause)),
			),
		value_declaration: ($) =>
			seq(
				$.kw_let,
				opt($.kw_rec),
				bareBinding($, $.binding_name),
			),

		attribute: ($) =>
			seq(
				$.hash_sign,
				field("path", $.path),
				opt(field("args", $.attribute_arguments_inline)),
			),
		attribute_arguments_inline: ($) =>
			collection($, $.lparen, $.rparen, $.attribute_argument, $.comma, {
				optional_separator: false,
			}),
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
			collection($, $.lbracket, $.rbracket, $.attribute_value, $.semicolon),
		attribute_record_value: ($) =>
			bracedCollection($, $.attribute_record_field, $.semicolon),
		attribute_record_field: ($) =>
			seq(
				field("name", $.field_name),
				$.equals,
				field("value", $.attribute_value),
			),
		attribute_argument: ($) =>
			choice(
				$.attribute_value,
				seq(
					field("name", $.identifier),
					$.equals,
					field("value", $.attribute_value),
				),
			),

		implementation: ($) =>
			seq(
				$.kw_fit,
				opt(field("type_params", $.type_parameter_list)),
				field("type", $.impl_type_head),
				$.colon,
				field("shape", $.path),
				opt(field("constraints", $.constraint_clause)),
				field("members", bracedCollection($, $.fit_member, $.semicolon)),
			),
		derive_declaration: ($) =>
			seq(
				$.kw_derive,
				opt(field("type_params", $.type_parameter_list)),
				field("type", $.impl_type_head),
				$.colon,
				field("shape", $.path),
				opt(field("constraints", $.constraint_clause)),
			),
		_concrete_type_head: ($) =>
			choice(
				$.path_or_applied,
				$.self_type,
				$.unit_type,
				$.tuple_type,
				$.record_type,
				$.parenthesized_type,
			),
		impl_type_head: ($) => $._concrete_type_head,
		fit_member: ($) => choice($.fit_type_def, $.fit_method),
		fit_type_def: ($) =>
			seq(
				attributePrefix($),
				$.kw_type,
				field("name", $.type_member_name),
				$.equals,
				field("value", $.type_body),
			),
		fit_method: ($) =>
			seq(
				attributePrefix($),
				field("name", $.identifier),
				opt(field("parameters", $.method_parameter_list)),
				$.fat_arrow,
				$.method_body,
			),
		method_parameter_list: ($) => parameterList($, $.binding_pattern),

		shape_declaration: ($) =>
			seq(
				$.kw_shape,
				field("name", $.binding_name),
				opt(field("type_params", $.type_parameter_list)),
				opt(field("parents", $.shape_parents)),
				field("members", bracedCollection($, $.shape_member, $.semicolon)),
			),
		shape_member: ($) => choice($.shape_type_decl, $.shape_method),
		shape_type_decl: ($) =>
			seq(attributePrefix($), $.kw_type, field("name", $.type_member_name)),
		shape_parents: ($) =>
			seq(
				$.colon,
				sep1(field("parent", $.path_or_applied), $.comma),
			),

		expect_statement: ($) =>
			seq($.kw_expect, field("value", $.expression)),
		test_declaration: ($) =>
			seq(
				$.kw_test,
				field("name", $.static_text),
				field("body", bracedCollection($, $.test_statement, $.semicolon)),
			),
		test_statement: ($) =>
			choice($.test_binding, $.test_value_declaration, $.expect_statement),
		test_binding: ($) => seq($.kw_let, $.binding_core),
		test_value_declaration: ($) => bareBinding($, $.binding_name),
		binding_core: ($) =>
			seq(
				opt($.kw_rec),
				field("pattern", $.binding_pattern),
				opt(seq($.colon, field("type_ann", $.type_body))),
				$.equals,
				$.value_slot,
			),

		binding_name: ($) => reserved("global", $.identifier),
		type_member_name: ($) => reserved("global", $.identifier),
		expression: ($) =>
			choice(
				$.lambda_expression,
				$.if_expression,
				$.let_expression,
				$.pipe_expression,
			),
		call_argument: ($) => $.postfix_expression,
		spread_element: ($) => seq($.rest_op, field("base", $.expression)),
		value_slot: ($) => field("value", $.expression),
		if_then_value: ($) => layoutExpr($, "then_value"),
		if_else_value: ($) => layoutExpr($, "else_value"),
		let_body: ($) => layoutExpr($, "body"),
		lambda_body: ($) => layoutExpr($, "body"),
		method_body: ($) => layoutExpr($, "body"),
		match_arm_value: ($) => layoutExpr($, "value"),

		// === Expression ladder ===
		pipe_expression: ($) =>
			prec.left(
				PREC.PIPE,
				seq(
					field("lhs", $.or_expression),
					many(seq($.pipe, field("rhs", $.or_expression))),
				),
			),
		or_expression: ($) =>
			prec.left(
				PREC.OR,
				seq(
					field("lhs", $.and_expression),
					many(seq($.or_op, field("rhs", $.and_expression))),
				),
			),
		and_expression: ($) =>
			prec.left(
				PREC.AND,
				seq(
					field("lhs", $.compare_expression),
					many(seq($.and_op, field("rhs", $.compare_expression))),
				),
			),
		compare_expression: ($) =>
			prec.left(
				PREC.COMPARE,
				seq(
					field("lhs", $.add_expression),
					opt(
						seq(
							field(
								"op",
								choice($.le_op, $.ge_op, $.eq_op, $.ne_op, $.lt_op, $.gt_op),
							),
							field("rhs", $.add_expression),
						),
					),
				),
			),
		add_expression: ($) =>
			prec.left(
				PREC.ADD,
				seq(
					field("lhs", $.mul_expression),
					many(
						seq(
							field("op", choice($.plus_op, $.minus_op)),
							field("rhs", $.mul_expression),
						),
					),
				),
			),
		mul_expression: ($) =>
			prec.left(
				PREC.MUL,
				seq(
					field("lhs", $.unary_expression),
					many(
						seq(
							field("op", choice($.star_op, $.slash_op, $.kw_mod)),
							field("rhs", $.unary_expression),
						),
					),
				),
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
						field("subject", $.application_expression),
						$.kw_to,
						field("body", bracedCollection($, $.match_arm, $.semicolon)),
					),
					$.application_expression,
				),
			),
		// Application is also non-recursive on its own branch (the callee is
		// a `postfix_expression`, not another `application_expression`), so
		// `prec.right` was load-bearing only as `prec`.
		application_expression: ($) =>
			prec(
				PREC.POSTFIX,
				choice(
					seq(
						field("callee", $.postfix_expression),
						$.kw_with,
						field("arg", $.call_argument),
						many(seq($.comma, field("arg", $.call_argument))),
						opt($.comma),
					),
					$.postfix_expression,
				),
			),
		postfix_expression: ($) =>
			prec.left(
				PREC.POSTFIX,
				seq(
					field("base", $.primary_expression),
					many(
						choice(
							$.record_suffix,
							$.call_suffix,
							$.index_suffix,
							$.field_suffix,
							$.try_op,
							$.method_suffix,
						),
					),
				),
			),
		primary_expression: ($) =>
			choice(
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

		call_suffix: ($) => seq($.lparen, $.rparen),
		index_suffix: ($) =>
			seq($.lbracket, field("index", $.expression), $.rbracket),
		field_suffix: ($) => seq($.dot, field("field", $.field_name)),
		method_suffix: ($) =>
			seq(
				$.at_sign,
				field("method", $.identifier),
				opt(seq($.colon, field("shape", $.path))),
			),
		record_suffix: ($) => field("body", $.record_body),

		unit_expression: ($) => seq($.lparen, $.rparen),
		list_expression: ($) =>
			collection($, $.lbracket, $.rbracket, $.list_item, $.semicolon),
		list_item: ($) => choice($.expression, $.spread_element),
		map_expression: ($) =>
			collection($, $.lbracket_map, $.rbracket, $.map_entry, $.semicolon),
		map_entry: ($) =>
			seq(field("key", $.expression), $.fat_arrow, $.value_slot),
		record_builder: ($) =>
			seq($.kw_build, field("builder", $.path), $.builder_body),
		record_body: ($) => bracedCollection($, $.record_field, $.semicolon),
		builder_body: ($) => bracedCollection($, $.builder_field, $.semicolon),
		record_field: ($) =>
			choice(
				seq(field("name", $.field_name), $.equals, $.value_slot),
				$.spread_element,
			),
		builder_field: ($) =>
			seq(field("name", $.field_name), $.left_arrow, $.value_slot),
		field_name: ($) => reserved("global", $.identifier),
		tuple_expression: ($) =>
			tuple($, $.lparen_hash, $.rparen, $.expression, $.semicolon, {
				optional_separator: false,
			}),
		parenthesized_expression: ($) =>
			seq($.lparen, field("value", $.expression), $.rparen),

		let_expression: ($) =>
			prec.right(
				seq(
					$.kw_let,
					separated1($, $.binding_core, $.semicolon),
					$.kw_in,
					$.let_body,
				),
			),
		match_arm: ($) =>
			seq(field("pattern", $.pattern), $.arrow, $.match_arm_value),
		lambda_parameters: ($) => parameterList($, $.binding_pattern),
		lambda_expression: ($) =>
			prec.right(seq($.kw_fn, $.lambda_parameters, $.fat_arrow, $.lambda_body)),
		if_expression: ($) =>
			prec.right(
				seq(
					$.kw_if,
					field("condition", $.pipe_expression),
					$.kw_then,
					$.if_then_value,
					$.kw_else,
					$.if_else_value,
				),
			),

		pattern: ($) =>
			seq($.unguarded_pattern, opt(seq($.kw_if, field("guard", $.expression)))),
		unguarded_pattern: ($) => $.or_pattern,
		binding_pattern: ($) =>
			choice(
				$.unit_pattern,
				$.wildcard_pattern,
				$.identifier,
				$.binding_list_pattern,
				$.binding_tuple_pattern,
				$.binding_record_pattern,
			),
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
			choice(
				withPayloads($, field("constructor", $.path), $.tag_payload_pattern),
				field("constructor", $.path),
			),
		wildcard_pattern: ($) => $.wildcard,
		unit_pattern: ($) => seq($.lparen, $.rparen),
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
			tuple($, $.lparen_hash, $.rparen, $.binding_pattern, $.semicolon, {
				optional_separator: false,
			}),
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
		tag_payload_pattern: ($) =>
			choice(
				$.literal,
				$.wildcard_pattern,
				$.path,
				$.list_pattern,
				$.tuple_pattern,
				$.record_pattern,
				seq($.lparen, $.pattern, $.rparen),
			),
		list_pattern: ($) =>
			seq(
				$.lbracket,
				separatedWithOptionalRest($.pattern, $.semicolon, $.rest_pattern),
				$.rbracket,
			),
		rest_pattern: ($) => seq($.rest_op, field("binding", $.identifier)),
		tuple_pattern: ($) =>
			tuple($, $.lparen_hash, $.rparen, $.pattern, $.semicolon, {
				optional_separator: false,
			}),
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

		path_or_applied: ($) =>
			seq(
				field("constructor", $.path),
				opt(field("args", $.type_argument_list)),
			),
		base_type: ($) =>
			choice(
				$.function_type,
				$.wildcard_type,
				$._concrete_type_head,
			),
		type_expression: ($) =>
			choice($.base_type, seq($.ellipsis, field("item", $.base_type))),
		type_body: ($) => layoutType($),
		ellipsis: ($) => "...",
		rest_op: ($) => "..",

		constraint_clause: ($) =>
			seq(
				$.kw_where,
				choice(
					$.constraint_entry,
					flexCollection($, $.lparen, $.rparen, $.constraint_entry, $.comma, {
						optional_separator: false,
					}),
				),
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
					field("shape", $.path),
					many(seq($.plus_op, field("shape", $.path))),
				),
			),
		function_type: ($) =>
			seq(
				$.kw_fn,
				collection(
					$,
					$.lparen,
					$.rparen,
					field("param", $.type_expression),
					$.comma,
					{ optional_separator: false },
				),
				opt(seq($.arrow, field("result", $.type_expression))),
			),
		self_type: ($) => $.kw_Self,
		type_argument_list: ($) =>
			collection($, $.lbracket, $.rbracket, $.type_expression, $.comma, {
				optional_separator: false,
			}),
		unit_type: ($) => seq($.lparen, $.rparen),
		record_type_field: ($) =>
			seq(
				attributePrefix($),
				field("name", $.field_name),
				$.colon,
				field("type_ann", $.type_body),
			),
		record_type: ($) =>
			flexCollection($, $.lbrace, $.rbrace, $.record_type_field, $.comma, {
				optional_separator: false,
			}),
		tuple_type: ($) =>
			tuple($, $.lparen_hash, $.rparen, $.type_expression, $.comma, {
				optional_separator: false,
			}),
		wildcard_type: ($) => $.wildcard,
		parenthesized_type: ($) => seq($.lparen, $.type_expression, $.rparen),

		literal: ($) =>
			choice(
				$.percent_literal,
				$.int_literal,
				$.float_literal,
				$.char_literal,
				$.text,
			),
		percent_literal: ($) =>
			token(
				choice(
					new RustRegex(`${DEC_DIGITS}\\.${DEC_DIGITS}${EXPONENT}?${PERCENT}`),
					new RustRegex(`${DEC_DIGITS}\\.${EXPONENT}?${PERCENT}`),
					new RustRegex(`\\.${DEC_DIGITS}${EXPONENT}?${PERCENT}`),
					new RustRegex(`${DEC_DIGITS}${EXPONENT}?${PERCENT}`),
				),
			),
		float_literal: ($) =>
			token(
				choice(
					new RustRegex(
						`${DEC_DIGITS}\\.${DEC_DIGITS}${EXPONENT}?${FLOAT_SUFFIX}`,
					),
					new RustRegex(`${DEC_DIGITS}\\.${EXPONENT}?${FLOAT_SUFFIX}`),
					new RustRegex(`\\.${DEC_DIGITS}${EXPONENT}?${FLOAT_SUFFIX}`),
					new RustRegex(`${DEC_DIGITS}${EXPONENT}${FLOAT_SUFFIX}`),
				),
			),
		int_literal: ($) =>
			token(
				choice(
					new RustRegex(`0[bB]${BIN_DIGITS}${INT_SUFFIX}`),
					new RustRegex(`0[oO]${OCT_DIGITS}${INT_SUFFIX}`),
					new RustRegex(`0[xX]${HEX_DIGITS}${INT_SUFFIX}`),
					new RustRegex(`${DEC_DIGITS}${INT_SUFFIX}`),
				),
			),

		text: ($) =>
			seq(
				$.quote,
				many(choice($.text_content, $.escape_sequence, $.interpolation)),
				$.quote,
			),
		text_content: ($) => token(new RustRegex('[^"\\\\]+')),
		char_literal: ($) =>
			token(
				choice(
					new RustRegex("'[^'\\\\]'"),
					new RustRegex(`'\\\\${CHAR_ESCAPE}'`),
				),
			),
		interpolation: ($) => seq($.interpolation_start, $.expression, $.rparen),
		interpolation_start: ($) => token(new RustRegex("\\\\\\(")),
		escape_sequence: ($) => token(new RustRegex(`\\\\${STRING_ESCAPE}`)),
		static_text: ($) =>
			seq(
				$.quote,
				many(choice($.static_text_content, $.escape_sequence)),
				$.quote,
			),
		static_text_content: ($) => token(new RustRegex('[^"\\\\]+')),
		line_comment: (_) => token(new RustRegex("//[^\\n]*")),
		block_comment: _ => token(seq('/>', /([^<]|<[^/])*/, '</')),

		identifier: ($) =>
			token(new RustRegex("[_\\p{ID_Start}][\\p{ID_Continue}]*!?")),
		path_head: ($) => choice($.identifier, $.kw_self),
		path: ($) => seq($.path_head, repeat(seq($.module_sep, $.identifier))),
		placeholder: ($) => token("__"),
		wildcard: ($) => "_",

		...Object.fromEntries(KEYWORDS.map((k) => [`kw_${k}`, () => k])),

		lparen: () => "(",
		rparen: () => ")",
		lbracket: () => "[",
		rbracket: () => "]",
		lbrace: () => "{",
		rbrace: () => "}",
		lparen_hash: () => token("#("),
		lbracket_map: () => token("#map["),
		quote: () => '"',
		comma: () => ",",
		colon: () => ":",
		equals: () => "=",
		semicolon: () => ";",
		dot: () => token.immediate("."),
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
		arrow: () => "->",
		left_arrow: () => "<-",
		fat_arrow: () => "=>",
		try_op: () => "?",
	},
});
