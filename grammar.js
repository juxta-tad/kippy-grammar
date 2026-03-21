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
	"match",
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

// --- Lexical Regex Constants ---
const DEC_DIGITS = "(?:[0-9]|[0-9][0-9_]*[0-9])";
const HEX_DIGITS = "(?:[0-9a-fA-F]|[0-9a-fA-F][0-9a-fA-F_]*[0-9a-fA-F])";
const OCT_DIGITS = "(?:[0-7]|[0-7][0-7_]*[0-7])";
const BIN_DIGITS = "(?:[01]|[01][01_]*[01])";

const INT_SUFFIX = "(?:u8|u16|u32|u64|i8|i16|i32|i64)?";
const FLOAT_SUFFIX = "(?:f32|f64)?";
const PERCENT = "%";
const EXPONENT = "(?:[eE][+-]?(?:[0-9]|[0-9][0-9_]*[0-9]))";

const CHAR_ESCAPE =
	`(?:[nrt0\\\\'"bfv]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})`;
const LINE_SPLICE = "\\r?\\n[ \\t]*";
const STRING_ESCAPE =
	`(?:u\\([0-9A-Fa-f]{1,8}\\)|x[0-9A-Fa-f]{2}|[\\\\'"ntrbfv]|${LINE_SPLICE})`;

const opt = optional;
const many = repeat;
const many1 = repeat1;

// --- Core List Helpers ---
function sep1(rule, separator) {
	return seq(rule, many(seq(separator, rule)));
}

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
	return seq(rule, many(next), opt(separator));
}

function lineSeparated1($, rule) {
	return seq(rule, many(seq(many1($.newline), rule)));
}

// Delimited collection with flexible interior
function delimited($, open, close, interior) {
	return seq(open, opt(seq(many($.newline), interior, many($.newline))), close);
}

// Braced newline-separated block
function bracedBlock($, rule) {
	return delimited($, $.lbrace, $.rbrace, lineSeparated1($, rule));
}

// --- Layout & Expression Helpers ---
function layoutExpr($, name = "value") {
	return field(name, seq(many($.newline), $.expression));
}

function layoutType($, name = "type") {
	return field(name, seq(many($.newline), $.type_expression));
}

function fileBody($, header, item) {
	return seq(
		many($.newline),
		opt(seq(header, many1($.newline))),
		opt(seq(item, many(seq(many1($.newline), item)), many($.newline))),
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

// Tuple form (2+ elements required)
function looseSeparated2Plus($, rule, separator) {
	const next = choice(
		seq(separator, rule),
		seq(opt(separator), many1($.newline), rule),
	);
	return seq(rule, next, many(next), opt(separator));
}

// Collection: delimited with interior separated items
function collection($, open, close, item, separator) {
	return delimited($, open, close, separated1($, item, separator));
}

// Tuple: delimited with 2+ elements required
function tuple($, open, close, item, separator) {
	return delimited(
		$,
		open,
		close,
		looseSeparated2Plus($, field("element", item), separator),
	);
}

// Braced collection with flexible separators
function bracedCollection($, rule, separator) {
	return delimited(
		$,
		$.lbrace,
		$.rbrace,
		seq(
			rule,
			many(choice(
				seq(separator, many($.newline), rule),
				seq(many1($.newline), separator, many($.newline), rule),
				seq(many1($.newline), rule),
			)),
			opt(seq(many($.newline), separator)),
		),
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
// Generates a full precedence ladder (pipe > or > and > compare > add > mul > unary).
// `suffix` allows generating parallel ladders (e.g. "_no_brace") that diverge only
// at the base rule, sharing all operator semantics.
function buildExpressionLadder(suffix, baseRule) {
	const name = (level) => `${level}${suffix}`;
	return {
		[name("pipe_expression")]: ($) =>
			prec.left(
				PREC.PIPE,
				seq(
					$[name("or_expression")],
					many(seq($.pipe, $[name("or_expression")])),
				),
			),
		[name("or_expression")]: ($) =>
			prec.left(
				PREC.OR,
				seq(
					$[name("and_expression")],
					many(seq($.or_op, $[name("and_expression")])),
				),
			),
		[name("and_expression")]: ($) =>
			prec.left(
				PREC.AND,
				seq(
					$[name("compare_expression")],
					many(seq($.and_op, $[name("compare_expression")])),
				),
			),
		[name("compare_expression")]: ($) =>
			prec.left(
				PREC.COMPARE,
				seq(
					$[name("add_expression")],
					opt(seq(
						choice($.le_op, $.ge_op, $.eq_op, $.ne_op, $.lt_op, $.gt_op),
						$[name("add_expression")],
					)),
				),
			),
		[name("add_expression")]: ($) =>
			prec.left(
				PREC.ADD,
				seq(
					$[name("mul_expression")],
					many(seq(choice($.plus_op, $.minus_op), $[name("mul_expression")])),
				),
			),
		[name("mul_expression")]: ($) =>
			prec.left(
				PREC.MUL,
				seq(
					$[name("unary_expression")],
					many(
						seq(
							choice($.star_op, $.slash_op, $.kw_mod),
							$[name("unary_expression")],
						),
					),
				),
			),
		[name("unary_expression")]: ($) =>
			choice(
				prec.right(
					PREC.UNARY,
					seq(
						choice($.minus_op, $.kw_not),
						$[name("unary_expression")],
					),
				),
				$[baseRule],
			),
	};
}

// Generate expression precedence ladders
const expressionRules = buildExpressionLadder("", "application_expression");
const noBraceExpressionRules = buildExpressionLadder("_no_brace", "application_expression_no_brace");

// --- Expression Bottom Generator ---
// Generates the four bottom rules (application, postfix, primary, inline)
// that sit below the operator ladder. The `suffix` parameter creates parallel
// variants, and `inlineChoices` controls which inline expression forms are
// included — this is where the no-brace chain diverges.
function buildExpressionBottom(suffix, inlineChoices, postfixSuffixes) {
	const s = (name) => `${name}${suffix}`;
	return {
		[s("application_expression")]: ($) =>
			prec.right(
				PREC.POSTFIX,
				choice(
					seq(
						$[s("postfix_expression")],
						$.kw_with,
						field("arg", $.call_argument_inline),
						many(
							seq(
								$.comma,
								many($.newline),
								field("arg", $.call_argument_inline),
							),
						),
					),
					seq(
						$[s("postfix_expression")],
						$.kw_with,
						many1($.newline),
						field("arg", $.call_argument_block),
						many(seq(many1($.newline), field("arg", $.call_argument_block))),
					),
					$[s("postfix_expression")],
				),
			),

		[s("postfix_expression")]: ($) =>
			prec.left(
				PREC.POSTFIX,
				seq(
					$[s("primary_expression")],
					many(choice(...postfixSuffixes($))),
				),
			),

		[s("primary_expression")]: ($) =>
			choice(
				$[s("inline_expression")],
				$.match_expression,
				$.if_expression,
				$.lambda_expression,
				$.let_expression,
			),

		[s("inline_expression")]: ($) => choice(...inlineChoices($)),
	};
}

// All inline expression forms
const INLINE_ALL = ($) => [
	$.record_builder,
	$.literal,
	$.path,
	$.placeholder,
	$.unit_expression,
	$.list_expression,
	$.map_expression,
	$.record_expression,
	$.tuple_expression,
	$.parenthesized_expression,
];

// Inline forms excluding brace-starting constructs (for match/if subjects)
const INLINE_NO_BRACE = ($) => [
	$.literal,
	$.path,
	$.placeholder,
	$.unit_expression,
	$.list_expression,
	$.map_expression,
	$.tuple_expression,
	$.parenthesized_expression,
];

// Postfix suffixes for general expression context (includes record construction)
const POSTFIX_ALL = ($) => [
	$.record_suffix,
	$.call_suffix,
	$.index_suffix,
	$.field_suffix,
	$.try_op,
	$.method_suffix,
];

// Postfix suffixes excluding brace-starting constructs (for match/if subjects)
const POSTFIX_NO_BRACE = ($) => [
	$.call_suffix,
	$.index_suffix,
	$.field_suffix,
	$.try_op,
	$.method_suffix,
];

const expressionBottom = buildExpressionBottom("", INLINE_ALL, POSTFIX_ALL);
const noBraceExpressionBottom = buildExpressionBottom("_no_brace", INLINE_NO_BRACE, POSTFIX_NO_BRACE);

module.exports = grammar({
	name: "kippy",

	word: ($) => $.identifier,

	reserved: {
		global: ($) => [
			$.kw_pub,
			$.kw_let,
			$.kw_rec,
			$.kw_alias,
			$.kw_distinct,
			$.kw_tag,
			$.kw_record,
			$.kw_choice,
			$.kw_expect,
			$.kw_if,
			$.kw_then,
			$.kw_else,
			$.kw_match,
			$.kw_in,
			$.kw_where,
			$.kw_with,
			$.kw_shape,
			$.kw_module,
			$.kw_use,
			$.kw_build,
			$.kw_type,
			$.kw_fit,
			$.kw_derive,
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

	extras: ($) => [
		new RustRegex("[ \\t\\r\\f]+"),
		$.line_comment,
		$.block_comment,
	],

	supertypes: ($) => [
		$.expression,
	],

	inline: ($) => [
		$.value_slot,
		$.match_arm_value,
		$.method_body,
		$.lambda_body,
		$.let_body,
		$.if_then_value,
		$.if_else_value,
	],

	rules: {
		source_file: ($) => fileBody($, $.module_declaration, $.module_item),
		module_item: ($) => choice($.use_statement, $.declaration),
		declaration: ($) =>
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
				$.expect_statement,
				$.implementation,
			),
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
				opt(separated1($, $.import_item, $.comma)),
				$.rbrace,
			),

		import_item: ($) =>
			seq(
				field("name", $.identifier),
				opt(seq($.kw_as, field("alias", $.identifier))),
			),
		module_declaration: ($) => seq($.kw_module, field("name", $.path)),
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
				opt($.type_parameter_list),
				$.equals,
				field("body", $.type_expression),
			),

		tag_declaration: ($) =>
			seq(
				$.kw_tag,
				field("name", $.binding_name),
				opt($.type_parameter_list),
			),

		record_declaration: ($) =>
			seq(
				$.kw_record,
				field("name", $.binding_name),
				opt($.type_parameter_list),
				many($.newline),
				field("body", $.record_type),
			),

		choice_declaration: ($) =>
			seq(
				$.kw_choice,
				field("name", $.binding_name),
				opt($.type_parameter_list),
				many($.newline),
				field("body", $.choice_body),
			),

		choice_body: ($) => bracedBlock($, $.choice_variant),

		choice_variant: ($) =>
			choice(
				seq(
					field("name", $.identifier),
					$.kw_with,
					field("payload", $.type_expression),
					many(
						seq($.comma, many($.newline), field("payload", $.type_expression)),
					),
				),
				seq(
					field("name", $.identifier),
					field("payload", $.record_type),
				),
				field("name", $.identifier),
			),

		type_parameter_list: ($) =>
			collection($, $.lbracket, $.rbracket, $.identifier, $.comma),
		shape_method: ($) =>
			seq(
				attributePrefix($),
				field("name", $.binding_name),
				$.colon,
				$.type_body,
				opt(field("default", $.method_default)),
				opt(field("constraints", $.constraint_clause)),
			),
		method_default: ($) => seq($.equals, $.value_slot),
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
		value_declaration: ($) =>
			seq(
				attributePrefix($),
				visibility_modifier($),
				field("name", $.binding_name),
				opt(seq($.colon, $.type_body)),
				$.equals,
				$.value_slot,
				opt($.semicolon),
			),
		attribute: ($) =>
			seq($.hash_sign, $.path, opt($.attribute_arguments_inline)),
		attribute_arguments_inline: ($) =>
			collection($, $.lparen, $.rparen, $.attribute_argument, $.comma),

		// Attribute values: restricted grammar for metadata (paths, literals, structured data, not control flow)
		attribute_value: ($) =>
			choice(
				$.literal,
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
				attributePrefix($),
				visibility_modifier($),
				$.kw_fit,
				opt($.type_parameter_list),
				field("type", $.impl_type_head),
				$.colon,
				field("shape", $.implementation_shapes),
				opt(field("constraints", $.constraint_clause)),
				many($.newline),
				field("members", bracedBlock($, $.fit_member)),
			),

		derive_declaration: ($) =>
			seq(
				attributePrefix($),
				visibility_modifier($),
				$.kw_derive,
				opt($.type_parameter_list),
				field("type", $.impl_type_head),
				$.colon,
				field("shape", $.implementation_shapes),
				opt(field("constraints", $.constraint_clause)),
				$.semicolon,
			),
		impl_type_head: ($) =>
			choice(
				$.applied_type,
				$.path,
				$.self_type,
				$.tuple_type,
				$.record_type,
				$.parenthesized_type,
			),
		implementation_shapes: ($) => $.path,
		fit_member: ($) => choice($.fit_type_def, $.fit_method),
		fit_type_def: ($) =>
			seq(
				$.kw_type,
				field("name", $.type_member_name),
				$.equals,
				field("value", $.type_body),
			),
		fit_method: ($) =>
			seq(
				field("name", $.identifier),
				opt(field("parameters", $.method_parameter_list)),
				$.fat_arrow,
				$.method_body,
			),
		method_parameter_list: ($) =>
			choice(
				sep1(field("param", $.binding_pattern), $.comma),
				seq(
					many1($.newline),
					separated1($, field("param", $.binding_pattern), $.comma),
					many($.newline),
				),
			),
		shape_declaration: ($) =>
			seq(
				attributePrefix($),
				visibility_modifier($),
				$.kw_shape,
				field("name", $.binding_name),
				opt($.type_parameter_list),
				opt(field("parents", $.shape_parents)),
				many($.newline),
				field("members", bracedBlock($, $.shape_member)),
			),
		shape_member: ($) => choice($.shape_type_decl, $.shape_method),
		shape_type_decl: ($) => seq($.kw_type, field("name", $.type_member_name)),
		shape_parents: ($) => seq($.colon, sep1(field("parent", $.path), $.comma)),
		expect_statement: ($) =>
			seq($.kw_expect, field("value", $.statement_expression)),
		test_declaration: ($) =>
			seq(
				attributePrefix($),
				$.kw_test,
				field("name", $.static_string),
				many($.newline),
				field("body", bracedBlock($, $.test_statement)),
			),
		test_statement: ($) =>
			choice($.test_binding, $.test_value_declaration, $.expect_statement),
		test_binding: ($) =>
			seq(
				$.kw_let,
				opt($.kw_rec),
				$.binding_pattern,
				opt(seq($.colon, $.type_body)),
				$.equals,
				$.value_slot,
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
				opt($.kw_rec),
				field("pattern", $.binding_pattern),
				opt(seq($.colon, $.type_body)),
				$.equals,
				$.value_slot,
			),
		binding_name: ($) => reserved("global", $.identifier),
		type_member_name: ($) => reserved("global", $.identifier),
		expression: ($) => $.pipe_expression,

		statement_expression: ($) => $.pipe_expression,

		// Arguments in comma-delimited call lists (same-line)
		call_argument_inline: ($) => $.postfix_expression,

		// Arguments in newline-delimited call lists: allow full expressions
		call_argument_block: ($) => $.pipe_expression,

		spread_element: ($) => seq($.rest_op, field("base", $.expression)),
		value_slot: ($) =>
			field("value", seq(many($.newline), $.statement_expression)),
		if_then_value: ($) => layoutExpr($, "then_value"),
		if_else_value: ($) => layoutExpr($, "else_value"),
		let_body: ($) => layoutExpr($, "body"),
		lambda_body: ($) => layoutExpr($, "body"),
		method_body: ($) => layoutExpr($, "body"),
		match_arm_value: ($) => layoutExpr($, "value"),
		...expressionRules,
		...noBraceExpressionRules,
		...expressionBottom,
		...noBraceExpressionBottom,

		// f() — postfix call sugar for `f with ()`
		call_suffix: ($) => seq($.lparen, many($.newline), $.rparen),

		index_suffix: ($) =>
			seq($.lbracket, field("index", $.expression), $.rbracket),
		field_suffix: ($) => seq($.dot, field("field", $.field_name)),

		method_suffix: ($) =>
			seq(
				$.at_sign,
				field("method", $.identifier),
				opt(seq($.colon, field("shape", $.path))),
			),

		// Foo { x = 1 } — record construction as postfix suffix on a path.
		// Only valid after a path in practice; semantic analysis can enforce this.
		record_suffix: ($) => field("body", $.record_body),

		// () — unit value
		unit_expression: ($) => seq($.lparen, many($.newline), $.rparen),

		list_expression: ($) =>
			collection($, $.lbracket, $.rbracket, $.list_item, $.semicolon),
		list_item: ($) => choice($.expression, $.spread_element),
		map_expression: ($) =>
			collection($, $.lbracket_map, $.rbracket, $.map_entry, $.semicolon),
		map_entry: ($) =>
			seq(field("key", $.expression), $.fat_arrow, $.value_slot),
		record_expression: ($) => $.record_body,
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
			tuple($, $.lparen_hash, $.rparen, $.expression, $.semicolon),
		parenthesized_expression: ($) =>
			seq(
				$.lparen,
				many($.newline),
				field("value", $.expression),
				many($.newline),
				$.rparen,
			),
		let_expression: ($) =>
			prec.right(
				seq(
					$.kw_let,
					choice(
						seq(lineSeparated1($, $.binding_core), many($.newline)),
						seq(
							many1($.newline),
							lineSeparated1($, $.binding_core),
							many($.newline),
						),
					),
					$.kw_in,
					$.let_body,
				),
			),
		match_expression: ($) =>
			prec.right(
				seq(
					$.kw_match,
					field("subject", $.pipe_expression_no_brace),
					many($.newline),
					field("body", bracedBlock($, $.match_arm)),
				),
			),
		match_arm: ($) =>
			seq(field("pattern", $.pattern), $.arrow, $.match_arm_value),
		lambda_parameters: ($) =>
			choice(
				sep1(field("param", $.binding_pattern), $.comma),
				seq(
					many1($.newline),
					lineSeparated1($, field("param", $.binding_pattern)),
					many($.newline),
				),
			),
		lambda_expression: ($) =>
			prec.right(choice(
				seq($.kw_fn, $.lparen, many($.newline), $.rparen, $.fat_arrow, $.lambda_body),
				seq($.kw_fn, $.lambda_parameters, $.fat_arrow, $.lambda_body),
			)),
		if_expression: ($) =>
			prec.right(
				seq(
					$.kw_if,
					field("condition", $.pipe_expression_no_brace),
					many($.newline),
					$.kw_then,
					$.if_then_value,
					many($.newline),
					$.kw_else,
					$.if_else_value,
				),
			),
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
				opt(seq(
					$.kw_with,
					field("payload", $.tag_payload_pattern),
					many(
						seq(
							$.comma,
							many($.newline),
							field("payload", $.tag_payload_pattern),
						),
					),
				)),
			),
		wildcard_pattern: ($) => $.wildcard,
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

		// Payload patterns in tag constructors: excludes path_pattern to prevent bare chaining
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
		base_type: ($) =>
			choice(
				$.function_type,
				$.applied_type,
				$.path,
				$.self_type,
				$.wildcard_type,
				$.tuple_type,
				$.record_type,
				$.parenthesized_type,
			),

		type_expression: ($) =>
			choice(
				$.base_type,
				seq($.ellipsis, field("item", $.base_type)),
			),
		type_body: ($) => layoutType($),
		ellipsis: ($) => "...",
		rest_op: ($) => "..",
		constraint_clause: ($) =>
			seq(
				$.kw_where,
				choice(
					$.constraint_entry,
					seq(
						$.lparen,
						many($.newline),
						$.constraint_entry,
						many(
							choice(
								seq($.comma, many($.newline), $.constraint_entry),
								seq(many1($.newline), $.constraint_entry),
							),
						),
						many($.newline),
						$.rparen,
					),
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
				seq(field("shape", $.path), many(seq($.plus_op, field("shape", $.path)))),
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
				),
				$.arrow,
				field("result", $.type_expression),
			),
		applied_type: ($) => seq($.path, $.type_argument_list),
		self_type: ($) => $.kw_Self,
		type_argument_list: ($) =>
			collection($, $.lbracket, $.rbracket, $.type_expression, $.comma),
		record_type_field: ($) =>
			seq(field("name", $.field_name), $.colon, $.type_body),
		record_type: ($) => bracedCollection($, $.record_type_field, $.semicolon),
		tuple_type: ($) =>
			tuple($, $.lparen_hash, $.rparen, $.type_expression, $.semicolon),
		wildcard_type: ($) => $.wildcard,
		parenthesized_type: ($) =>
			seq(
				$.lparen,
				many($.newline),
				$.type_expression,
				many($.newline),
				$.rparen,
			),
		literal: ($) =>
			choice(
				$.percent_literal,
				$.int_literal,
				$.float_literal,
				$.char_literal,
				$.string,
			),
		// 50% => desugars to 50 / 100. Only unsuffixed numeric forms allowed.
		percent_literal: ($) =>
			token(
				choice(
					new RustRegex(
						`${DEC_DIGITS}\\.${DEC_DIGITS}${EXPONENT}?${PERCENT}`,
					),
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
		string: ($) =>
			seq(
				$.quote,
				many(choice($.string_content, $.escape_sequence, $.interpolation)),
				$.quote,
			),
		string_content: ($) => token(new RustRegex('[^"\\\\\\n]+')),
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
		static_string: ($) =>
			seq(
				$.quote,
				many(choice($.static_string_text, $.escape_sequence)),
				$.quote,
			),
		static_string_text: ($) => token(new RustRegex('[^"\\\\\\n]+')),
		line_comment: (_) => token(new RustRegex("//[^\\n]*")),
		block_comment: (_) =>
			token(seq("/>", new RustRegex("([^<]|<[^/])*"), "</")),
		identifier: ($) =>
			token(new RustRegex("[_\\p{ID_Start}][\\p{ID_Continue}]*!?")),
		path_head: ($) => choice($.identifier, $.kw_self),
		path: ($) => seq($.path_head, repeat(seq($.module_sep, $.identifier))),
		newline: () => token(new RustRegex("\\r?\\n")),
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
		hash_sign: () => token.immediate("#"),
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
