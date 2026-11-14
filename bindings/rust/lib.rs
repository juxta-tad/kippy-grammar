//! Kippy grammar for tree-sitter.

use tree_sitter_language::LanguageFn;

extern "C" {
    fn tree_sitter_kippy() -> *const ();
}

/// The tree-sitter language for Kippy.
pub const LANGUAGE: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_kippy) };

/// Contents of `src/node-types.json`.
pub const NODE_TYPES: &str = include_str!("../../src/node-types.json");

/// Contents of `src/grammar.json`.
pub const GRAMMAR_JSON: &str = include_str!("../../src/grammar.json");

#[cfg(test)]
mod tests {
    #[test]
    fn loads() {
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&super::LANGUAGE.into()).expect("ABI mismatch");
    }
}
