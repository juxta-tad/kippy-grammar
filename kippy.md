Best early semantics

Use these rules:

_ creates a fresh anonymous type variable

each _ is independent

So:

_ -> _

means argument and result may be different.

But:

T -> T

means same type both places.

That distinction is important.
