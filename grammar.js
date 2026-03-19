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

// --- Lexical Regex Constants ---
const DEC_DIGITS = "(?:[0-9]|[0-9][0-9_]*[0-9])";
const HEX_DIGITS = "(?:[0-9a-fA-F]|[0-9a-fA-F][0-9a-fA-F_]*[0-9a-fA-F])";
const OCT_DIGITS = "(?:[0-7]|[0-7][0-7_]*[0-7])";
const BIN_DIGITS = "(?:[01]|[01][01_]*[01])";

const INT_SUFFIX = "(?:u8|u16|u32|u64|i8|i16|i32|i64)?%?";
const FLOAT_SUFFIX = "(?:f32|f64)?%?";
const EXPONENT = "(?:[eE][+-]?(?:[0-9]|[0-9][0-9_]*[0-9]))";

const CHAR_ESCAPE = `(?:[nrt0\\\\'"bfv]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})`;
const STRING_ESCAPE = `(?:u\\([0-9A-Fa-f]{1,8}\\)|x[0-9A-Fa-f]{2}|[\\\\'"ntrbfv])`;

const opt = optional;
const many = repeat;
const many1 = repeat1;

// --- Basic Inline Separators ---
function sep1(rule, separator) {
	return seq(rule, many(seq(separator, rule)));
}

function layoutExpr($, name = "value") {
	return field(name, seq(many($.newline), $.expression));
}

function layoutType($, name = "type") {
	return field(name, seq(many($.newline), $.type_expression));
}

// --- Block & Layout Helpers ---

function fileBody($, header, item) {
	return seq(
		many($.newline),
		opt(seq(header, many1($.newline))),
		opt(seq(
			item,
			many(seq(many1($.newline), item)),
			many($.newline),
		)),
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

// Pure list helper (newline separated)
function lineSeparated1($, rule) {
	return seq(
		rule,
		many(seq(many1($.newline), rule)),
	);
}

// Continuation-sensitive argument list (same-line or newline-separated)
function argumentList($) {
	return seq(
		field("arg", $.call_argument),
		many(choice(
			seq($.comma, many($.newline), field("arg", $.call_argument)),
			seq(many1($.newline), field("arg", $.call_argument)),
		)),
	);
}

// Explicitly terminated scope block helper
function bracedBlock($, rule) {
	return seq(
		$.lbrace,
		opt(seq(
			many($.newline),
			lineSeparated1($, rule),
			many($.newline),
		)),
		$.rbrace,
	);
}

// Comma-separated list with optional newlines after commas (no trailing comma, no bare newlines)
function commaSeparated1NoTrailing($, rule) {
	return seq(
		rule,
		many(seq($.comma, many($.newline), rule)),
	);
}

// Comma-separated list with optional newlines after commas (no bare newlines)
function commaSeparated1($, rule) {
	return seq(
		rule,
		many(seq($.comma, many($.newline), rule)),
		opt($.comma),
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

// Explicit braced separator form
function bracedSeparated1($, rule, separator) {
	const next = choice(
		seq(separator, many($.newline), rule),
		seq(many1($.newline), separator, many($.newline), rule),
		seq(many1($.newline), rule),
	);

	return seq(
		rule,
		many(next),
		opt(seq(many($.newline), separator)),
	);
}

function bracedCollection($, rule, separator) {
	return seq(
		$.lbrace,
		opt(seq(
			many($.newline),
			bracedSeparated1($, rule, separator),
			many($.newline),
		)),
		$.rbrace,
	);
}

// --- Expression Ladder Generator ---
function buildExpressionLadder(EXPR, baseRule) {
	return {
		[EXPR.pipe]: ($) =>
			prec.left(
				PREC.PIPE,
				seq(
					$[EXPR.or],
					many(seq($.pipe, $[EXPR.or])),
				),
			),
		[EXPR.or]: ($) =>
			prec.left(
				PREC.OR,
				seq(
					$[EXPR.and],
					many(seq($.or_op, $[EXPR.and])),
				),
			),
		[EXPR.and]: ($) =>
			prec.left(
				PREC.AND,
				seq(
					$[EXPR.compare],
					many(seq($.and_op, $[EXPR.compare])),
				),
			),
		[EXPR.compare]: ($) =>
			prec.left(
				PREC.COMPARE,
				seq(
					$[EXPR.add],
					opt(seq(
						choice($.le_op, $.ge_op, $.eq_op, $.ne_op, $.lt_op, $.gt_op),
						$[EXPR.add],
					)),
				),
			),
		[EXPR.add]: ($) =>
			prec.left(
				PREC.ADD,
				seq(
					$[EXPR.mul],
					many(seq(choice($.plus, $.minus), $[EXPR.mul])),
				),
			),
		[EXPR.mul]: ($) =>
			prec.left(
				PREC.MUL,
				seq(
					$[EXPR.unary],
					many(
						seq(
							choice($.star, $.slash, $.kw_mod),
							$[EXPR.unary],
						),
					),
				),
			),
		[EXPR.unary]: ($) =>
			choice(
				prec.right(
					PREC.UNARY,
					seq(
						choice($.minus, $.kw_not, $.kw_cert),
						$[EXPR.unary],
					),
				),
				$[baseRule],
			),
	};
}

// Expression precedence level names
const EXPR = Object.freeze({
	pipe: "pipe_expression",
	or: "or_expression",
	and: "and_expression",
	compare: "compare_expression",
	add: "add_expression",
	mul: "mul_expression",
	unary: "unary_expression",
});

// Generate expression precedence ladder
const expressionRules = buildExpressionLadder(EXPR, "postfix_expression");

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
			$.kw_cert,
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
			$.kw_unit,
		],
	},

	extras: ($) => [
		new RustRegex("[ \\t\\r\\f]+"),
		$.line_comment,
		$.block_comment,
		$.doc_comment,
		$.doc_block_comment,
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
		declaration: ($) => choice(
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
				field("body", $.type_record),
			),

		choice_declaration: ($) =>
			seq(
				$.kw_choice,
				field("name", $.binding_name),
				opt($.type_parameter_list),
				field("body", $.choice_body),
			),

		choice_body: ($) => bracedBlock($, $.choice_variant),

		choice_variant: ($) =>
			choice(
				seq(
					field("name", $.identifier),
					$.kw_with,
					commaSeparated1NoTrailing($, field("payload", $.type_expression)),
				),
				seq(
					field("name", $.identifier),
					field("payload", $.type_record),
				),
				field("name", $.identifier),
			),

		type_parameter_list: ($) => collection($, $.lt_op, $.gt_op, $.identifier, $.comma),
		shape_method: ($) => seq(attributePrefix($), field("name", $.binding_name), $.colon, $.type_body, opt(field("default", $.method_default)), opt(field("constraints", $.constraint_clause))),
		method_default: ($) => seq($.equals, $.value_slot),
		signature: ($) => seq(attributePrefix($), visibility_modifier($), $.kw_sig, field("name", $.identifier), $.colon, $.type_body, opt(field("constraints", $.constraint_clause))),
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
		attribute: ($) => seq($.hash_sign, $.path, opt($.attribute_arguments_inline)),
		attribute_arguments_inline: ($) => collection($, $.lparen, $.rparen, $.attribute_argument, $.comma),

		// Attribute values: restricted grammar for metadata (paths, literals, structured data, not control flow)
		attribute_value: ($) =>
			choice(
				$.literal,
				$.path,
				$.attribute_list_value,
				$.attribute_record_value,
				seq($.lparen, $.attribute_value, $.rparen),
			),

		attribute_list_value: ($) => collection($, $.lbracket, $.rbracket, $.attribute_value, $.semicolon),
		attribute_record_value: ($) => bracedCollection($, $.attribute_record_field, $.semicolon),
		attribute_record_field: ($) => seq(field("name", $.field_name), $.equals, field("value", $.attribute_value)),

		attribute_argument: ($) =>
			choice(
				$.attribute_value,
				seq(field("name", $.identifier), $.equals, field("value", $.attribute_value)),
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
		impl_type_head: ($) => choice($.type_application, $.path, $.self_type, $.type_tuple, $.type_record, $.parenthesized_type),
		implementation_shapes: ($) => $.path,
		fit_member: ($) => choice($.fit_type_def, $.fit_method),
		fit_type_def: ($) => seq($.kw_type, field("name", $.type_member_name), $.equals, field("value", $.type_body)),
		fit_method: ($) => seq(field("name", $.identifier), opt(field("parameters", $.method_parameter_list)), $.fat_arrow, $.method_body),
		method_parameter_list: ($) => choice(sep1(field("param", $.binding_pattern), $.comma), seq(many1($.newline), separated1($, field("param", $.binding_pattern), $.comma), many($.newline))),
		shape_declaration: ($) => seq(attributePrefix($), visibility_modifier($), $.kw_shape, field("name", $.binding_name), opt($.type_parameter_list), opt(field("parents", $.shape_parents)), field("members", bracedBlock($, $.shape_member))),
		shape_member: ($) => choice($.shape_type_decl, $.shape_method),
		shape_type_decl: ($) => seq($.kw_type, field("name", $.type_member_name)),
		shape_parents: ($) => seq($.colon, sep1(field("parent", $.path), $.comma)),
		expect_statement: ($) => seq($.kw_expect, field("value", $.expression)),
		test_declaration: ($) => seq(attributePrefix($), $.kw_test, field("name", $.static_string), field("body", bracedBlock($, $.test_statement))),
		test_statement: ($) => choice($.test_binding, $.test_value_declaration, $.expect_statement),
		test_binding: ($) => seq($.kw_let, opt($.kw_rec), $.binding_pattern, opt(seq($.colon, $.type_body)), $.equals, $.value_slot),
		test_value_declaration: ($) => seq(field("name", $.binding_name), opt(seq($.colon, $.type_body)), $.equals, $.value_slot),
		binding_core: ($) => seq(opt($.kw_rec), field("pattern", $.binding_pattern), opt(seq($.colon, $.type_body)), $.equals, $.value_slot),
		binding_name: ($) => reserved("global", $.identifier),
		type_member_name: ($) => reserved("global", $.identifier),
		expression: ($) => $.pipe_expression,
		arm_inline_expression: ($) => $.pipe_expression,
		call_argument: ($) => $.pipe_expression,

		// Arguments in comma-delimited call lists (same-line): exclude tag_value_expression to prevent ambiguity
		call_argument_inline: ($) => $.comma_safe_expression,

		// Arguments in newline-delimited call lists: allow full expressions
		call_argument_block: ($) => $.pipe_expression,

		call_suffix: ($) =>
			prec.right(
				seq(
					$.kw_with,
					choice(
						// Comma-separated arguments (same-line): use comma_safe_expression
						seq(
							field("arg", $.call_argument_inline),
							many(seq($.comma, many($.newline), field("arg", $.call_argument_inline))),
						),
						// Newline-separated arguments (block form): use full pipe_expression
						seq(
							many1($.newline),
							field("arg", $.call_argument_block),
							many(
								choice(
									seq($.comma, many($.newline), field("arg", $.call_argument_block)),
									seq(many1($.newline), field("arg", $.call_argument_block)),
								),
							),
						),
					),
				),
			),

		spread_element: ($) => seq($.rest_op, field("base", $.expression)),
		primary_expression: ($) => choice($.inline_expression, $.match_expression, $.if_expression, $.lambda_expression, $.let_expression),
		value_slot: ($) => layoutExpr($, "value"),
		if_then_value: ($) => layoutExpr($, "then_value"),
		if_else_value: ($) => layoutExpr($, "else_value"),
		let_body: ($) => layoutExpr($, "body"),
		lambda_body: ($) => layoutExpr($, "body"),
		method_body: ($) => layoutExpr($, "body"),
		match_arm_value: ($) => layoutExpr($, "value"),
		...expressionRules,
		postfix_expression: ($) =>
			prec.left(
				PREC.POSTFIX,
				seq(
					$.primary_expression,
					many(choice(
						$.index_suffix,
						$.field_suffix,
						$.try_op,
						$.method_suffix,
					)),
				),
			),

		index_suffix: ($) => seq($.lbracket, field("index", $.expression), $.rbracket),
		field_suffix: ($) => seq($.dot, field("field", $.field_name)),

		// Method suffix: x@method or x@method:Shape with optional call
		method_suffix: ($) => seq(
			$.at_sign,
			field("method", $.identifier),
			opt(seq($.colon, field("shape", $.path))),
			opt($.call_suffix),
		),
		constructed_record_expression: ($) => prec(1, seq(field("constructor", $.path), field("body", $.record_body))),

		// Expressions safe in comma-delimited parent lists (excludes undelimited comma-separated tag_value_expression)
		// Used for: attribute arguments, function arguments, etc. Nested tag values must be parenthesized.
		comma_safe_expression: ($) =>
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
				$.match_expression,
				$.if_expression,
				$.lambda_expression,
				$.let_expression,
			),

		// Payload expressions in tag constructors: excludes bare tag_value_expression to require parentheses for nesting
		tag_payload_expression: ($) =>
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
				$.match_expression,
				$.if_expression,
				$.lambda_expression,
				$.let_expression,
			),

		tag_value_expression: ($) =>
			seq(
				field("constructor", $.path),
				$.kw_with,
				commaSeparated1NoTrailing($, field("payload", $.tag_payload_expression)),
			),

		inline_expression: ($) => choice($.constructed_record_expression, $.record_builder, $.tag_value_expression, $.literal, $.path, $.placeholder, $.list_expression, $.map_expression, $.record_expression, $.tuple_expression, $.parenthesized_expression),
		list_expression: ($) => collection($, $.lbracket, $.rbracket, $.list_item, $.semicolon),
		list_item: ($) => choice($.expression, $.spread_element),
		map_expression: ($) => collection($, $.lbracket_hash, $.rbracket, $.map_entry, $.semicolon),
		map_entry: ($) => seq(field("key", $.expression), $.fat_arrow, $.value_slot),
		record_expression: ($) => $.record_body,
		record_builder: ($) => seq($.kw_build, field("builder", $.path), $.builder_body),
		record_body: ($) => bracedCollection($, $.record_field, $.semicolon),
		builder_body: ($) => bracedCollection($, $.builder_field, $.semicolon),
		record_field: ($) => choice(seq(field("name", $.field_name), $.equals, $.value_slot), $.spread_element),
		builder_field: ($) => seq(field("name", $.field_name), $.left_arrow, $.value_slot),
		field_name: ($) => reserved("global", $.identifier),
		tuple_expression: ($) => tuple($, $.lparen_hash, $.rparen, $.expression, $.semicolon),
		parenthesized_expression: ($) => seq($.lparen, many($.newline), field("value", $.expression), many($.newline), $.rparen),
		let_expression: ($) => prec.right(seq($.kw_let, choice(seq(lineSeparated1($, $.binding_core), many($.newline)), seq(many1($.newline), lineSeparated1($, $.binding_core), many($.newline))), $.kw_in, $.let_body)),
		match_expression: ($) => prec.right(seq($.kw_match, field("subject", $.pipe_expression), field("body", bracedBlock($, $.match_arm)))),
		match_arm: ($) => seq(field("pattern", $.pattern), $.arrow, $.match_arm_value),
		lambda_parameters: ($) => choice(sep1(field("param", $.binding_pattern), $.comma), seq(many1($.newline), lineSeparated1($, field("param", $.binding_pattern)), many($.newline))),
		lambda_expression: ($) => prec.right(seq($.kw_fn, $.lambda_parameters, $.fat_arrow, $.lambda_body)),
		if_expression: ($) => prec.right(seq($.kw_if, field("condition", $.pipe_expression), $.kw_then, $.if_then_value, many($.newline), $.kw_else, $.if_else_value)),
		pattern: ($) => seq($.unguarded_pattern, opt(seq($.kw_if, field("guard", $.expression)))),
		unguarded_pattern: ($) => $.or_pattern,
		binding_pattern: ($) => choice($.wildcard_pattern, $.identifier, $.binding_list_pattern, $.binding_tuple_pattern, $.binding_record_pattern),
		or_pattern: ($) => prec.left(sep1($.as_pattern, $.pipe_bar)),
		as_pattern: ($) =>
			prec.right(
				1,
				choice(
					seq($.atomic_pattern, $.kw_as, field("binding", $.identifier)),
					$.atomic_pattern,
				),
			),
		atomic_pattern: ($) => choice($.literal, $.wildcard_pattern, $.identifier, $.tag_pattern, $.list_pattern, $.tuple_pattern, $.record_pattern, seq($.lparen, $.pattern, $.rparen)),
		wildcard_pattern: ($) => $.wildcard,
		binding_list_pattern: ($) => seq($.lbracket, separatedWithOptionalRest($.binding_pattern, $.semicolon, $.rest_pattern), $.rbracket),
		binding_tuple_pattern: ($) => tuple($, $.lparen_hash, $.rparen, $.binding_pattern, $.semicolon),
		binding_record_pattern: ($) => seq($.lbrace, separatedWithOptionalRest($.binding_record_pattern_field, $.semicolon, $.rest_op), $.rbrace),
		binding_record_pattern_field: ($) => fieldPattern($.field_name, $.colon, $.binding_pattern),
		tag_pattern: ($) => choice($.nullary_tag_pattern, $.with_tag_pattern),

		// Payload patterns in tag constructors: excludes with_tag_pattern to prevent bare chaining
		// Nested tag patterns must be parenthesized: X with (Y with z)
		tag_payload_pattern: ($) =>
			choice(
				$.literal,
				$.wildcard_pattern,
				$.identifier,
				$.nullary_tag_pattern,
				$.list_pattern,
				$.tuple_pattern,
				$.record_pattern,
				seq($.lparen, $.pattern, $.rparen),
			),

		with_tag_pattern: ($) =>
			seq(
				field("constructor", $.path),
				$.kw_with,
				commaSeparated1NoTrailing($, field("payload", $.tag_payload_pattern)),
			),
		nullary_tag_pattern: ($) => prec(2, alias(
			seq($.path_head, many1(seq($.module_sep, $.identifier))),
			$.path,
		)),
		list_pattern: ($) => seq($.lbracket, separatedWithOptionalRest($.pattern, $.semicolon, $.rest_pattern), $.rbracket),
		rest_pattern: ($) => seq($.rest_op, field("binding", $.identifier)),
		tuple_pattern: ($) => tuple($, $.lparen_hash, $.rparen, $.pattern, $.semicolon),
		record_pattern: ($) => seq($.lbrace, separatedWithOptionalRest($.record_pattern_field, $.semicolon, $.rest_op), $.rbrace),
		record_pattern_field: ($) => fieldPattern($.field_name, $.colon, $.pattern),
		type_expression: ($) =>
			choice(
				$.function_type,
				$.type_application,
				$.path,
				$.self_type,
				$.type_wildcard,
				$.type_tuple,
				$.type_record,
				$.parenthesized_type,
				seq($.ellipsis, field("item", choice(
					$.function_type,
					$.type_application,
					$.path,
					$.self_type,
					$.type_wildcard,
					$.type_tuple,
					$.type_record,
					$.parenthesized_type,
				))),
			),
		type_body: ($) => layoutType($),
		record_field_type: ($) => $.type_body,
		ellipsis: ($) => token(prec(1, "...")),
		rest_op: ($) => "..",
		constraint_clause: ($) => seq($.kw_where, choice($.constraint_entry, seq($.lparen, many($.newline), $.constraint_entry, many(choice(seq($.comma, many($.newline), $.constraint_entry), seq(many1($.newline), $.constraint_entry))), many($.newline), $.rparen))),
		constraint_entry: ($) => seq(field("type_var", $.identifier), $.colon, field("constraint", $.constraint_sum)),
		constraint_sum: ($) => prec.left(seq(field("shape", $.path), many(seq($.plus, field("shape", $.path))))),
		function_type: ($) => seq($.kw_fn, collection($, $.lparen, $.rparen, field("param", $.type_expression), $.comma), $.arrow, field("result", $.type_expression)),
		type_application: ($) => prec(1, seq($.path, $.type_argument_list)),
		self_type: ($) => $.kw_Self,
		type_argument_list: ($) => collection($, $.lt_op, $.gt_op, $.type_expression, $.comma),
		record_type_field: ($) => seq(field("name", $.field_name), $.colon, $.record_field_type),
		type_record: ($) => bracedCollection($, $.record_type_field, $.semicolon),
		type_tuple: ($) => tuple($, $.lparen_hash, $.rparen, $.type_expression, $.semicolon),
		type_wildcard: ($) => $.wildcard,
		parenthesized_type: ($) => seq($.lparen, many($.newline), $.type_expression, many($.newline), $.rparen),
		literal: ($) => choice($.unit_literal, $.int_literal, $.float_literal, $.char_literal, $.string),
		unit_literal: ($) => $.kw_unit,
		float_literal: ($) => token(choice(new RustRegex(`${DEC_DIGITS}\\.${DEC_DIGITS}${EXPONENT}?${FLOAT_SUFFIX}`), new RustRegex(`${DEC_DIGITS}\\.${EXPONENT}?${FLOAT_SUFFIX}`), new RustRegex(`\\.${DEC_DIGITS}${EXPONENT}?${FLOAT_SUFFIX}`), new RustRegex(`${DEC_DIGITS}${EXPONENT}${FLOAT_SUFFIX}`))),
		int_literal: ($) => token(choice(new RustRegex(`0[bB]${BIN_DIGITS}${INT_SUFFIX}`), new RustRegex(`0[oO]${OCT_DIGITS}${INT_SUFFIX}`), new RustRegex(`0[xX]${HEX_DIGITS}${INT_SUFFIX}`), new RustRegex(`${DEC_DIGITS}${INT_SUFFIX}`))),
		string: ($) => seq($.quote, many(choice($.string_content, $.escape_sequence, $.interpolation)), $.quote),
		string_content: ($) => token(new RustRegex('[^"\\\\\\n]+')),
		char_literal: ($) => token(choice(new RustRegex("'[^'\\\\]'"), new RustRegex(`'\\\\${CHAR_ESCAPE}'`))),
		interpolation: ($) => seq($.interpolation_start, $.expression, $.rparen),
		interpolation_start: ($) => token(new RustRegex("\\\\\\(")),
		escape_sequence: ($) => token(new RustRegex(`\\\\${STRING_ESCAPE}`)),
		static_string: ($) => seq($.quote, many(choice($.static_string_text, $.escape_sequence)), $.quote),
		static_string_text: ($) => token(new RustRegex('[^"\\\\\\n]+')),
		doc_comment: (_) => token(prec(2, seq("///", new RustRegex("[^\\n]*"), many(seq("\n", "///", new RustRegex("[^\\n]*")))))),
		line_comment: (_) => token(prec(1, new RustRegex("//[^\\n]*"))),
		block_comment: (_) => token(prec(-3, seq("/>", new RustRegex("[\\s\\S]*?"), "</"))),
		doc_block_comment: (_) => token(prec(2, seq("<///", new RustRegex("[\\s\\S]*?"), "///"))),
		identifier: ($) => token(new RustRegex("[_\\p{ID_Start}][\\p{ID_Continue}]*!?")),
		capitalized_identifier: ($) => token(new RustRegex("[A-Z][\\p{ID_Continue}]*!?")),
		path_head: ($) => choice($.identifier, $.kw_self),
		path: ($) => seq($.path_head, repeat(seq($.module_sep, $.identifier))),
		newline: () => token(new RustRegex("\\r?\\n")),
		placeholder: ($) => token("__"),
		wildcard: ($) => "_",
		kw_pub: () => "pub",
		kw_let: () => "let",
		kw_rec: () => "rec",
		kw_alias: () => "alias",
		kw_distinct: () => "distinct",
		kw_tag: () => "tag",
		kw_record: () => "record",
		kw_choice: () => "choice",
		kw_cert: () => "cert",
		kw_expect: () => "expect",
		kw_if: () => "if",
		kw_then: () => "then",
		kw_else: () => "else",
		kw_match: () => "match",
		kw_in: () => "in",
		kw_where: () => "where",
		kw_with: () => "with",
		kw_shape: () => "shape",
		kw_module: () => "module",
		kw_use: () => "use",
		kw_build: () => "build",
		kw_type: () => "type",
		kw_fit: () => "fit",
		kw_derive: () => "derive",
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
		kw_unit: () => "unit",
		lparen: () => "(",
		rparen: () => ")",
		lbracket: () => "[",
		rbracket: () => "]",
		lbrace: () => "{",
		rbrace: () => "}",
		lparen_hash: () => token("#("),
		lbracket_hash: () => token("#map["),
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
