package formula

import (
	"fmt"
	"strings"
)

// BuildSQL converts an AST into a parameterized SQL subquery that returns lead_ids
// matching the formula. The query operates on lead_tags + tags tables.
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

// buildLiteral produces: SELECT lt.lead_id FROM lead_tags lt JOIN tags t ... WHERE LOWER(t.name) = $N AND t.account_id = $1
func buildLiteral(node *Node, args []interface{}, argIdx int) (string, []interface{}, int, error) {
	var cond string
	if node.IsLike {
		cond = fmt.Sprintf("LOWER(t.name) LIKE $%d", argIdx)
	} else {
		cond = fmt.Sprintf("LOWER(t.name) = $%d", argIdx)
	}

	sql := fmt.Sprintf(
		`SELECT DISTINCT lt.lead_id FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id JOIN leads l ON l.id = lt.lead_id WHERE l.account_id = $1 AND %s`,
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
		`(SELECT id AS lead_id FROM leads WHERE account_id = $1 EXCEPT (%s))`,
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

// ─── Participant variant ────────────────────────────────────────────────────

// BuildSQLForParticipants converts an AST into a SQL subquery that returns participant IDs
// matching the formula. Uses lead_tags through event_participants.lead_id to match by the lead's real tags.
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
		`SELECT DISTINCT p.id AS participant_id FROM event_participants p JOIN lead_tags lt ON lt.lead_id = p.lead_id JOIN tags t ON t.id = lt.tag_id WHERE p.event_id = $1 AND %s`,
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
