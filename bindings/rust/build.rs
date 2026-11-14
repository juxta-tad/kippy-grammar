fn main() {
    let src = std::path::Path::new("src");
    println!("cargo:rerun-if-changed=src/parser.c");
    cc::Build::new()
        .std("c11")
        .include(src)
        .file(src.join("parser.c"))
        .compile("tree-sitter-kippy");
}
