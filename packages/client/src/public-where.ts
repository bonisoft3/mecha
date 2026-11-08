/** The `where` of a public table's rows, which a session reaches without a
 * minted token: services/auth/jwt.ts's PUBLIC_WHERE, which the gates compare
 * by equality. Kept free of imports so the gates' tests can hold the two equal. */
export const PUBLIC_WHERE = "scope_id IN ('public:')"
