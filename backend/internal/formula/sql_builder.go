package formula

import (
	"fmt"
	"regexp"
	"strings"
)

// BuildSQL converts an AST into a parameterized SQL subquery that returns lead_ids
// matching the formula. The query operates on contact_tags + tags tables.
//
// Parameters:
//   - node: AST root from Parse()
//   - accountID: tenant filter value (will be $1 in the output)
//
// Returns:
//   - sql: a complete SELECT query returning matching lead_ids
//   - args: parameter values to pass alongside the SQL
//   - err: any construction error
//
// The generated SQL uses set operations:
//   - AND → INTERSECT of child queries
//   - OR  → UNION of child queries
//   - NOT → EXCEPT child query
//   - Literal exact → leads having a tag with LOWER(name) = $N
//   - Literal LIKE  → leads having a tag with LOWER(name) LIKE $N
func BuildSQL(node *Node, accountID interface{}) (string, []interface{}, error) {
	if node == nil {
		return "SELECT id AS lead_id FROM leads WHERE FALSE", nil, nil
	}

	args := []interface{}{accountID}
	argIdx := 2 // $1 is accountID

	sql, newArgs, _, err := buildNode(node, args, argIdx)
	if err != nil {
		return "", nil, err
	}

	return sql, newArgs, nil
}

// buildNode recursively builds SQL for a single AST node.
// Returns the SQL fragment, updated args slice, next arg index, and any error.
func buildNode(node *Node, args []interface{}, argIdx int) (string, []interface{}, int, error) {
	switch node.Type {
	case NodeLiteral:
		return buildLiteral(node, args, argIdx)
	case NodeNot:
		return buildNot(node, args, argIdx)
	case NodeAnd:
		return buildSetOp(node, "INTERSECT", args, argIdx)
	case NodeOr:
		return buildSetOp(node, "UNION", args, argIdx)
	default:
		return "", nil, argIdx, fmt.Errorf("unknown node type %d", node.Type)
	}
}

// buildLiteral produces a query that finds lead IDs matching a tag via contact_tags
func buildLiteral(node *Node, args []interface{}, argIdx int) (string, []interface{}, int, error) {
	var cond string
	if node.IsLike {
		cond = fmt.Sprintf("LOWER(t.name) LIKE $%d", argIdx)
	} else {
		cond = fmt.Sprintf("LOWER(t.name) = $%d", argIdx)
	}

	sql := fmt.Sprintf(
		`SELECT DISTINCT l.id AS lead_id FROM leads l JOIN contact_tags ct ON ct.contact_id = l.contact_id JOIN tags t ON t.id = ct.tag_id WHERE l.account_id = $1 AND l.is_archived = false AND l.is_blocked = false AND %s`,
		cond,
	)

	args = append(args, node.Value)
	return sql, args, argIdx + 1, nil
}

// buildNot produces: SELECT id AS lead_id FROM leads WHERE account_id = $1 EXCEPT (child_sql)
func buildNot(node *Node, args []interface{}, argIdx int) (string, []interface{}, int, error) {
	childSQL, newArgs, newIdx, err := buildNode(node.Children[0], args, argIdx)
	if err != nil {
		return "", nil, newIdx, err
	}

	// All leads in the account EXCEPT those matching the child
	sql := fmt.Sprintf(
		`(SELECT id AS lead_id FROM leads WHERE account_id = $1 AND is_archived = false AND is_blocked = false EXCEPT (%s))`,
		childSQL,
	)

	return sql, newArgs, newIdx, nil
}

// buildSetOp produces: (child1) INTERSECT/UNION (child2) INTERSECT/UNION ...
func buildSetOp(node *Node, op string, args []interface{}, argIdx int) (string, []interface{}, int, error) {
	if len(node.Children) == 0 {
		return "", args, argIdx, fmt.Errorf("%s node has no children", op)
	}

	var parts []string
	currentArgs := args
	currentIdx := argIdx

	for _, child := range node.Children {
		childSQL, newArgs, newIdx, err := buildNode(child, currentArgs, currentIdx)
		if err != nil {
			return "", nil, newIdx, err
		}
		parts = append(parts, "("+childSQL+")")
		currentArgs = newArgs
		currentIdx = newIdx
	}

	sql := strings.Join(parts, " "+op+" ")
	return sql, currentArgs, currentIdx, nil
}

// BuildCountSQL wraps the formula SQL to produce a count of matching leads.
func BuildCountSQL(node *Node, accountID interface{}) (string, []interface{}, error) {
	inner, args, err := BuildSQL(node, accountID)
	if err != nil {
		return "", nil, err
	}
	sql := fmt.Sprintf("SELECT COUNT(*) FROM (%s) AS formula_matches", inner)
	return sql, args, nil
}

// ─── All-status variant (includes archived/blocked) ─────────────────────────

// BuildSQLAll is like BuildSQL but does NOT filter by is_archived/is_blocked.
// Used to count hidden leads that match the formula but are archived/blocked.
func BuildSQLAll(node *Node, accountID interface{}) (string, []interface{}, error) {
	if node == nil {
		return "SELECT id AS lead_id FROM leads WHERE FALSE", nil, nil
	}
	args := []interface{}{accountID}
	argIdx := 2
	sql, newArgs, _, err := buildNodeAll(node, args, argIdx)
	if err != nil {
		return "", nil, err
	}
	return sql, newArgs, nil
}

func buildNodeAll(node *Node, args []interface{}, argIdx int) (string, []interface{}, int, error) {
	switch node.Type {
	case NodeLiteral:
		return buildLiteralAll(node, args, argIdx)
	case NodeNot:
		return buildNotAll(node, args, argIdx)
	case NodeAnd:
		return buildSetOpAll(node, "INTERSECT", args, argIdx)
	case NodeOr:
		return buildSetOpAll(node, "UNION", args, argIdx)
	default:
		return "", nil, argIdx, fmt.Errorf("unknown node type %d", node.Type)
	}
}

func buildLiteralAll(node *Node, args []interface{}, argIdx int) (string, []interface{}, int, error) {
	var cond string
	if node.IsLike {
		cond = fmt.Sprintf("LOWER(t.name) LIKE $%d", argIdx)
	} else {
		cond = fmt.Sprintf("LOWER(t.name) = $%d", argIdx)
	}
	sql := fmt.Sprintf(
		`SELECT DISTINCT l.id AS lead_id FROM leads l JOIN contact_tags ct ON ct.contact_id = l.contact_id JOIN tags t ON t.id = ct.tag_id WHERE l.account_id = $1 AND %s`,
		cond,
	)
	args = append(args, node.Value)
	return sql, args, argIdx + 1, nil
}

func buildNotAll(node *Node, args []interface{}, argIdx int) (string, []interface{}, int, error) {
	childSQL, newArgs, newIdx, err := buildNodeAll(node.Children[0], args, argIdx)
	if err != nil {
		return "", nil, newIdx, err
	}
	sql := fmt.Sprintf(
		`(SELECT id AS lead_id FROM leads WHERE account_id = $1 EXCEPT (%s))`,
		childSQL,
	)
	return sql, newArgs, newIdx, nil
}

func buildSetOpAll(node *Node, op string, args []interface{}, argIdx int) (string, []interface{}, int, error) {
	if len(node.Children) == 0 {
		return "", args, argIdx, fmt.Errorf("%s node has no children", op)
	}
	var parts []string
	currentArgs := args
	currentIdx := argIdx
	for _, child := range node.Children {
		childSQL, newArgs, newIdx, err := buildNodeAll(child, currentArgs, currentIdx)
		if err != nil {
			return "", nil, newIdx, err
		}
		parts = append(parts, "("+childSQL+")")
		currentArgs = newArgs
		currentIdx = newIdx
	}
	sql := strings.Join(parts, " "+op+" ")
	return sql, currentArgs, currentIdx, nil
}

// ─── Contact variant ────────────────────────────────────────────────────────

// BuildSQLForContacts converts an AST into a SQL subquery that returns contact IDs
// matching the formula. Uses contact_tags directly.
// $1 = accountID in the generated SQL.
func BuildSQLForContacts(node *Node, accountID interface{}) (string, []interface{}, error) {
	if node == nil {
		return "SELECT id AS contact_id FROM contacts WHERE FALSE", nil, nil
	}
	args := []interface{}{accountID}
	argIdx := 2
	sql, newArgs, _, err := buildContactNode(node, args, argIdx)
	if err != nil {
		return "", nil, err
	}
	return sql, newArgs, nil
}

func buildContactNode(node *Node, args []interface{}, argIdx int) (string, []interface{}, int, error) {
	switch node.Type {
	case NodeLiteral:
		return buildContactLiteral(node, args, argIdx)
	case NodeNot:
		return buildContactNot(node, args, argIdx)
	case NodeAnd:
		return buildContactSetOp(node, "INTERSECT", args, argIdx)
	case NodeOr:
		return buildContactSetOp(node, "UNION", args, argIdx)
	default:
		return "", nil, argIdx, fmt.Errorf("unknown node type %d", node.Type)
	}
}

func buildContactLiteral(node *Node, args []interface{}, argIdx int) (string, []interface{}, int, error) {
	var cond string
	if node.IsLike {
		cond = fmt.Sprintf("LOWER(t.name) LIKE $%d", argIdx)
	} else {
		cond = fmt.Sprintf("LOWER(t.name) = $%d", argIdx)
	}
	sql := fmt.Sprintf(
		`SELECT DISTINCT ct.contact_id AS contact_id FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id JOIN contacts c ON c.id = ct.contact_id WHERE c.account_id = $1 AND %s`,
		cond,
	)
	args = append(args, node.Value)
	return sql, args, argIdx + 1, nil
}

func buildContactNot(node *Node, args []interface{}, argIdx int) (string, []interface{}, int, error) {
	childSQL, newArgs, newIdx, err := buildContactNode(node.Children[0], args, argIdx)
	if err != nil {
		return "", nil, newIdx, err
	}
	sql := fmt.Sprintf(
		`(SELECT id AS contact_id FROM contacts WHERE account_id = $1 AND is_group = false EXCEPT (%s))`,
		childSQL,
	)
	return sql, newArgs, newIdx, nil
}

func buildContactSetOp(node *Node, op string, args []interface{}, argIdx int) (string, []interface{}, int, error) {
	if len(node.Children) == 0 {
		return "", args, argIdx, fmt.Errorf("%s node has no children", op)
	}
	var parts []string
	currentArgs := args
	currentIdx := argIdx
	for _, child := range node.Children {
		childSQL, newArgs, newIdx, err := buildContactNode(child, currentArgs, currentIdx)
		if err != nil {
			return "", nil, newIdx, err
		}
		parts = append(parts, "("+childSQL+")")
		currentArgs = newArgs
		currentIdx = newIdx
	}
	sql := strings.Join(parts, " "+op+" ")
	return sql, currentArgs, currentIdx, nil
}

// ─── Participant variant ────────────────────────────────────────────────────

// BuildSQLForParticipants converts an AST into a SQL subquery that returns participant IDs
// matching the formula. Uses contact_tags through event_participants.contact_id.
// $1 = eventID in the generated SQL.
func BuildSQLForParticipants(node *Node, eventID interface{}) (string, []interface{}, error) {
	if node == nil {
		return "SELECT id AS participant_id FROM event_participants WHERE FALSE", nil, nil
	}

	args := []interface{}{eventID}
	argIdx := 2

	sql, newArgs, _, err := buildParticipantNode(node, args, argIdx)
	if err != nil {
		return "", nil, err
	}

	return sql, newArgs, nil
}

func buildParticipantNode(node *Node, args []interface{}, argIdx int) (string, []interface{}, int, error) {
	switch node.Type {
	case NodeLiteral:
		return buildParticipantLiteral(node, args, argIdx)
	case NodeNot:
		return buildParticipantNot(node, args, argIdx)
	case NodeAnd:
		return buildParticipantSetOp(node, "INTERSECT", args, argIdx)
	case NodeOr:
		return buildParticipantSetOp(node, "UNION", args, argIdx)
	default:
		return "", nil, argIdx, fmt.Errorf("unknown node type %d", node.Type)
	}
}

func buildParticipantLiteral(node *Node, args []interface{}, argIdx int) (string, []interface{}, int, error) {
	var cond string
	if node.IsLike {
		cond = fmt.Sprintf("LOWER(t.name) LIKE $%d", argIdx)
	} else {
		cond = fmt.Sprintf("LOWER(t.name) = $%d", argIdx)
	}
	sql := fmt.Sprintf(
		`SELECT DISTINCT p.id AS participant_id FROM event_participants p JOIN contact_tags ct ON ct.contact_id = p.contact_id JOIN tags t ON t.id = ct.tag_id WHERE p.event_id = $1 AND %s`,
		cond,
	)
	args = append(args, node.Value)
	return sql, args, argIdx + 1, nil
}

func buildParticipantNot(node *Node, args []interface{}, argIdx int) (string, []interface{}, int, error) {
	childSQL, newArgs, newIdx, err := buildParticipantNode(node.Children[0], args, argIdx)
	if err != nil {
		return "", nil, newIdx, err
	}
	sql := fmt.Sprintf(
		`(SELECT id AS participant_id FROM event_participants WHERE event_id = $1 EXCEPT (%s))`,
		childSQL,
	)
	return sql, newArgs, newIdx, nil
}

func buildParticipantSetOp(node *Node, op string, args []interface{}, argIdx int) (string, []interface{}, int, error) {
	if len(node.Children) == 0 {
		return "", args, argIdx, fmt.Errorf("%s node has no children", op)
	}
	var parts []string
	currentArgs := args
	currentIdx := argIdx
	for _, child := range node.Children {
		childSQL, newArgs, newIdx, err := buildParticipantNode(child, currentArgs, currentIdx)
		if err != nil {
			return "", nil, newIdx, err
		}
		parts = append(parts, "("+childSQL+")")
		currentArgs = newArgs
		currentIdx = newIdx
	}
	sql := strings.Join(parts, " "+op+" ")
	return sql, currentArgs, currentIdx, nil
}

// RemapSQLParams rewrites $1, $2... in a SQL string to $offset+0, $offset+1...
// Uses regexp word boundaries to avoid corrupting $10 when replacing $1.
func RemapSQLParams(sql string, paramCount int, offset int) string {
	for i := paramCount; i >= 1; i-- {
		re := regexp.MustCompile(fmt.Sprintf(`\$%d\b`, i))
		sql = re.ReplaceAllLiteralString(sql, fmt.Sprintf("$%d", offset+i-1))
	}
	return sql
}
