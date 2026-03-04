package formula

import (
	"strings"
)

// Evaluate checks if a set of tag names (lowercase) satisfies the formula AST.
// Used for real-time hooks (HandleLeadTagAssigned/Removed) where we already
// have the lead's tags in memory.
//
// tagNames must be pre-lowercased.
func Evaluate(node *Node, tagNames []string) bool {
	if node == nil {
		return true // empty formula matches everything
	}
	tagSet := make(map[string]bool, len(tagNames))
	for _, t := range tagNames {
		tagSet[t] = true
	}
	return evalNode(node, tagNames, tagSet)
}

func evalNode(node *Node, tagNames []string, tagSet map[string]bool) bool {
	switch node.Type {
	case NodeLiteral:
		return matchLiteral(node, tagNames, tagSet)
	case NodeNot:
		return !evalNode(node.Children[0], tagNames, tagSet)
	case NodeAnd:
		for _, child := range node.Children {
			if !evalNode(child, tagNames, tagSet) {
				return false
			}
		}
		return true
	case NodeOr:
		for _, child := range node.Children {
			if evalNode(child, tagNames, tagSet) {
				return true
			}
		}
		return false
	}
	return false
}

// matchLiteral checks if the tag pattern matches any tag in the set.
// Exact match uses the hash set. LIKE match needs linear scan.
func matchLiteral(node *Node, tagNames []string, tagSet map[string]bool) bool {
	if !node.IsLike {
		// Exact match (case-insensitive since both sides are already lowercased)
		return tagSet[node.Value]
	}
	// LIKE pattern — support % as wildcard (SQL LIKE semantics)
	pattern := node.Value
	for _, name := range tagNames {
		if likeMatch(name, pattern) {
			return true
		}
	}
	return false
}

// likeMatch implements simple SQL LIKE matching:
//   - '%' matches zero or more characters
//   - everything else matches literally (case-insensitive, both should be lowercase)
//
// Does NOT support '_' wildcard for simplicity.
func likeMatch(s, pattern string) bool {
	return likeMatchDP(strings.ToLower(s), strings.ToLower(pattern))
}

// likeMatchDP uses dynamic programming to match a string against a LIKE pattern.
func likeMatchDP(s, p string) bool {
	sLen := len(s)
	pLen := len(p)

	// dp[i][j] = s[:i] matches p[:j]
	dp := make([][]bool, sLen+1)
	for i := range dp {
		dp[i] = make([]bool, pLen+1)
	}
	dp[0][0] = true

	// Leading % can match empty string
	for j := 1; j <= pLen; j++ {
		if p[j-1] == '%' {
			dp[0][j] = dp[0][j-1]
		}
	}

	for i := 1; i <= sLen; i++ {
		for j := 1; j <= pLen; j++ {
			if p[j-1] == '%' {
				// % matches zero chars (dp[i][j-1]) or one more char (dp[i-1][j])
				dp[i][j] = dp[i][j-1] || dp[i-1][j]
			} else if p[j-1] == s[i-1] {
				dp[i][j] = dp[i-1][j-1]
			}
		}
	}

	return dp[sLen][pLen]
}
