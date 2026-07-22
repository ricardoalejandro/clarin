package api

import "fmt"

// canonicalLead*Expr deliberately uses a Lead snapshot only when the Lead is
// genuinely detached. A linked Contact remains authoritative even when one of
// its canonical values is NULL/empty; falling through to l.<field> would make
// a value explicitly cleared by the user reappear.
const (
	canonicalLeadNameExpr            = `CASE WHEN l.contact_id IS NULL THEN COALESCE(l.name,'') ELSE COALESCE(c.custom_name,c.name,c.push_name,c.phone,c.jid,'') END`
	canonicalLeadLastNameExpr        = `CASE WHEN l.contact_id IS NULL THEN COALESCE(l.last_name,'') ELSE COALESCE(c.last_name,'') END`
	canonicalLeadPhoneExpr           = `CASE WHEN l.contact_id IS NULL THEN COALESCE(l.phone,'') ELSE COALESCE(c.phone,'') END`
	canonicalLeadEmailExpr           = `CASE WHEN l.contact_id IS NULL THEN COALESCE(l.email,'') ELSE COALESCE(c.email,'') END`
	canonicalLeadCompanyExpr         = `CASE WHEN l.contact_id IS NULL THEN COALESCE(l.company,'') ELSE COALESCE(c.company,'') END`
	canonicalParticipantNameExpr     = `CASE WHEN COALESCE(p.contact_id,l.contact_id) IS NULL THEN COALESCE(p.name,'') ELSE COALESCE(contact.custom_name,contact.name,contact.push_name,contact.phone,contact.jid,'') END`
	canonicalParticipantLastNameExpr = `CASE WHEN COALESCE(p.contact_id,l.contact_id) IS NULL THEN COALESCE(p.last_name,'') ELSE COALESCE(contact.last_name,'') END`
	canonicalParticipantPhoneExpr    = `CASE WHEN COALESCE(p.contact_id,l.contact_id) IS NULL THEN COALESCE(p.phone,'') ELSE COALESCE(contact.phone,'') END`
	canonicalParticipantEmailExpr    = `CASE WHEN COALESCE(p.contact_id,l.contact_id) IS NULL THEN COALESCE(p.email,'') ELSE COALESCE(contact.email,'') END`
)

func canonicalLeadSearchClause(arg int, includeTitle bool) string {
	parts := []string{
		"LOWER(" + canonicalLeadNameExpr + ") LIKE $%d",
		"LOWER(" + canonicalLeadPhoneExpr + ") LIKE $%d",
		"LOWER(" + canonicalLeadEmailExpr + ") LIKE $%d",
		"LOWER(" + canonicalLeadCompanyExpr + ") LIKE $%d",
		"LOWER(" + canonicalLeadLastNameExpr + ") LIKE $%d",
	}
	if includeTitle {
		parts = append(parts[:1], append([]string{"LOWER(l.title) LIKE $%d"}, parts[1:]...)...)
	}
	clause := "(" + parts[0]
	for _, part := range parts[1:] {
		clause += " OR " + part
	}
	clause += ")"
	values := make([]any, len(parts))
	for i := range values {
		values[i] = arg
	}
	return fmt.Sprintf(clause, values...)
}

func canonicalParticipantSearchClause(arg int) string {
	return fmt.Sprintf(
		"(LOWER("+canonicalParticipantNameExpr+") LIKE $%d OR LOWER("+canonicalParticipantPhoneExpr+") LIKE $%d OR LOWER("+canonicalParticipantEmailExpr+") LIKE $%d OR LOWER("+canonicalParticipantLastNameExpr+") LIKE $%d)",
		arg, arg, arg, arg,
	)
}
