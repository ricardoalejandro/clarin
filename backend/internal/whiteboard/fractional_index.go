package whiteboard

// This file ports the fractional-indexing 3.2.0 key generator (CC0-1.0)
// used by Excalidraw 0.18.1, plus the invalid-index grouping contract from
// Excalidraw's MIT-licensed fractionalIndex.ts. See THIRD_PARTY_NOTICES.md.

import (
	"encoding/json"
	"fmt"
	"strings"
)

const base62Digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

func midpointFraction(a string, b *string) (string, error) {
	zero := base62Digits[0]
	if b != nil && a >= *b {
		return "", fmt.Errorf("invalid fractional bounds: %s >= %s", a, *b)
	}
	if strings.HasSuffix(a, string(zero)) || (b != nil && *b != "" && strings.HasSuffix(*b, string(zero))) {
		return "", fmt.Errorf("fractional key has trailing zero")
	}
	if b != nil && *b != "" {
		n := 0
		for n < len(*b) {
			charA := zero
			if n < len(a) {
				charA = a[n]
			}
			if charA != (*b)[n] {
				break
			}
			n++
		}
		if n > 0 {
			rest, err := midpointFraction(sliceFrom(a, n), stringPointer((*b)[n:]))
			if err != nil {
				return "", err
			}
			return (*b)[:n] + rest, nil
		}
	}
	digitA := 0
	if a != "" {
		digitA = strings.IndexByte(base62Digits, a[0])
	}
	digitB := len(base62Digits)
	if b != nil {
		if *b == "" {
			return "", fmt.Errorf("empty upper fractional bound")
		}
		digitB = strings.IndexByte(base62Digits, (*b)[0])
	}
	if digitA < 0 || digitB < 0 {
		return "", fmt.Errorf("invalid fractional digit")
	}
	if digitB-digitA > 1 {
		middle := (digitA + digitB + 1) / 2
		return string(base62Digits[middle]), nil
	}
	if b != nil && len(*b) > 1 {
		return (*b)[:1], nil
	}
	rest, err := midpointFraction(sliceFrom(a, 1), nil)
	if err != nil {
		return "", err
	}
	return string(base62Digits[digitA]) + rest, nil
}

func sliceFrom(value string, index int) string {
	if index >= len(value) {
		return ""
	}
	return value[index:]
}

func stringPointer(value string) *string { return &value }

func integerLength(head byte) (int, error) {
	switch {
	case head >= 'a' && head <= 'z':
		return int(head-'a') + 2, nil
	case head >= 'A' && head <= 'Z':
		return int('Z'-head) + 2, nil
	default:
		return 0, fmt.Errorf("invalid order key head: %q", head)
	}
}

func integerPart(key string) (string, error) {
	if key == "" {
		return "", fmt.Errorf("empty order key")
	}
	length, err := integerLength(key[0])
	if err != nil || length > len(key) {
		return "", fmt.Errorf("invalid order key: %s", key)
	}
	return key[:length], nil
}

func validateInteger(value string) error {
	if value == "" {
		return fmt.Errorf("empty integer part")
	}
	length, err := integerLength(value[0])
	if err != nil || len(value) != length {
		return fmt.Errorf("invalid integer part of order key: %s", value)
	}
	return nil
}

func validateOrderKey(key string) error {
	if key == "A"+strings.Repeat(string(base62Digits[0]), 26) {
		return fmt.Errorf("invalid order key: %s", key)
	}
	integer, err := integerPart(key)
	if err != nil {
		return err
	}
	fraction := key[len(integer):]
	if strings.HasSuffix(fraction, string(base62Digits[0])) && fraction != "" {
		return fmt.Errorf("invalid order key: %s", key)
	}
	return nil
}

func incrementInteger(value string) (*string, error) {
	if err := validateInteger(value); err != nil {
		return nil, err
	}
	head := value[0]
	digits := []byte(value[1:])
	carry := true
	for index := len(digits) - 1; carry && index >= 0; index-- {
		position := strings.IndexByte(base62Digits, digits[index]) + 1
		if position <= 0 {
			return nil, fmt.Errorf("invalid integer digit")
		}
		if position == len(base62Digits) {
			digits[index] = base62Digits[0]
		} else {
			digits[index] = base62Digits[position]
			carry = false
		}
	}
	if !carry {
		result := string(head) + string(digits)
		return &result, nil
	}
	if head == 'Z' {
		result := "a" + string(base62Digits[0])
		return &result, nil
	}
	if head == 'z' {
		return nil, nil
	}
	nextHead := head + 1
	if nextHead > 'a' {
		digits = append(digits, base62Digits[0])
	} else if len(digits) > 0 {
		digits = digits[:len(digits)-1]
	}
	result := string(nextHead) + string(digits)
	return &result, nil
}

func decrementInteger(value string) (*string, error) {
	if err := validateInteger(value); err != nil {
		return nil, err
	}
	head := value[0]
	digits := []byte(value[1:])
	borrow := true
	for index := len(digits) - 1; borrow && index >= 0; index-- {
		position := strings.IndexByte(base62Digits, digits[index]) - 1
		if position < -1 {
			return nil, fmt.Errorf("invalid integer digit")
		}
		if position == -1 {
			digits[index] = base62Digits[len(base62Digits)-1]
		} else {
			digits[index] = base62Digits[position]
			borrow = false
		}
	}
	if !borrow {
		result := string(head) + string(digits)
		return &result, nil
	}
	if head == 'a' {
		result := "Z" + string(base62Digits[len(base62Digits)-1])
		return &result, nil
	}
	if head == 'A' {
		return nil, nil
	}
	previousHead := head - 1
	if previousHead < 'Z' {
		digits = append(digits, base62Digits[len(base62Digits)-1])
	} else if len(digits) > 0 {
		digits = digits[:len(digits)-1]
	}
	result := string(previousHead) + string(digits)
	return &result, nil
}

func generateKeyBetween(lower, upper *string) (string, error) {
	if lower != nil {
		if err := validateOrderKey(*lower); err != nil {
			return "", err
		}
	}
	if upper != nil {
		if err := validateOrderKey(*upper); err != nil {
			return "", err
		}
	}
	if lower != nil && upper != nil && *lower >= *upper {
		return "", fmt.Errorf("invalid order bounds: %s >= %s", *lower, *upper)
	}
	if lower == nil {
		if upper == nil {
			return "a" + string(base62Digits[0]), nil
		}
		upperInteger, err := integerPart(*upper)
		if err != nil {
			return "", err
		}
		upperFraction := (*upper)[len(upperInteger):]
		if upperInteger == "A"+strings.Repeat(string(base62Digits[0]), 26) {
			middle, err := midpointFraction("", &upperFraction)
			return upperInteger + middle, err
		}
		if upperInteger < *upper {
			return upperInteger, nil
		}
		decremented, err := decrementInteger(upperInteger)
		if err != nil || decremented == nil {
			return "", fmt.Errorf("cannot decrement fractional integer")
		}
		return *decremented, nil
	}
	if upper == nil {
		lowerInteger, err := integerPart(*lower)
		if err != nil {
			return "", err
		}
		lowerFraction := (*lower)[len(lowerInteger):]
		incremented, err := incrementInteger(lowerInteger)
		if err != nil {
			return "", err
		}
		if incremented != nil {
			return *incremented, nil
		}
		middle, err := midpointFraction(lowerFraction, nil)
		return lowerInteger + middle, err
	}
	lowerInteger, err := integerPart(*lower)
	if err != nil {
		return "", err
	}
	lowerFraction := (*lower)[len(lowerInteger):]
	upperInteger, err := integerPart(*upper)
	if err != nil {
		return "", err
	}
	upperFraction := (*upper)[len(upperInteger):]
	if lowerInteger == upperInteger {
		middle, err := midpointFraction(lowerFraction, &upperFraction)
		return lowerInteger + middle, err
	}
	incremented, err := incrementInteger(lowerInteger)
	if err != nil || incremented == nil {
		return "", fmt.Errorf("cannot increment fractional integer")
	}
	if *incremented < *upper {
		return *incremented, nil
	}
	middle, err := midpointFraction(lowerFraction, nil)
	return lowerInteger + middle, err
}

func generateNKeysBetween(lower, upper *string, count int) ([]string, error) {
	if count < 0 {
		return nil, fmt.Errorf("negative fractional key count")
	}
	if count == 0 {
		return []string{}, nil
	}
	if count == 1 {
		key, err := generateKeyBetween(lower, upper)
		return []string{key}, err
	}
	if upper == nil {
		result := make([]string, 0, count)
		cursor, err := generateKeyBetween(lower, nil)
		if err != nil {
			return nil, err
		}
		result = append(result, cursor)
		for index := 0; index < count-1; index++ {
			cursorCopy := cursor
			cursor, err = generateKeyBetween(&cursorCopy, nil)
			if err != nil {
				return nil, err
			}
			result = append(result, cursor)
		}
		return result, nil
	}
	if lower == nil {
		result := make([]string, 0, count)
		cursor, err := generateKeyBetween(nil, upper)
		if err != nil {
			return nil, err
		}
		result = append(result, cursor)
		for index := 0; index < count-1; index++ {
			cursorCopy := cursor
			cursor, err = generateKeyBetween(nil, &cursorCopy)
			if err != nil {
				return nil, err
			}
			result = append(result, cursor)
		}
		for left, right := 0, len(result)-1; left < right; left, right = left+1, right-1 {
			result[left], result[right] = result[right], result[left]
		}
		return result, nil
	}
	middleCount := count / 2
	middle, err := generateKeyBetween(lower, upper)
	if err != nil {
		return nil, err
	}
	left, err := generateNKeysBetween(lower, &middle, middleCount)
	if err != nil {
		return nil, err
	}
	right, err := generateNKeysBetween(&middle, upper, count-middleCount-1)
	if err != nil {
		return nil, err
	}
	return append(append(left, middle), right...), nil
}

func validFractionalIndex(index, predecessor, successor string) bool {
	if index == "" {
		return false
	}
	switch {
	case predecessor != "" && successor != "":
		return predecessor < index && index < successor
	case predecessor == "" && successor != "":
		return index < successor
	case predecessor != "" && successor == "":
		return predecessor < index
	default:
		return true
	}
}

func syncInvalidElementIndices(elements []decodedElement, mutation elementIndexMutation) error {
	groups := invalidElementIndexGroups(elements)
	for _, group := range groups {
		if len(group) < 2 {
			continue
		}
		lowerIndex, upperIndex := group[0], group[len(group)-1]
		var lower, upper *string
		if lowerIndex >= 0 && lowerIndex < len(elements) && elements[lowerIndex].index != "" {
			value := elements[lowerIndex].index
			lower = &value
		}
		if upperIndex >= 0 && upperIndex < len(elements) && elements[upperIndex].index != "" {
			value := elements[upperIndex].index
			upper = &value
		}
		indices, err := generateNKeysBetween(lower, upper, len(group)-2)
		if err != nil {
			return fmt.Errorf("generate fractional indices: %w", err)
		}
		for offset, elementIndex := range group[1 : len(group)-1] {
			if err := setDecodedElementIndex(&elements[elementIndex], indices[offset], mutation); err != nil {
				return err
			}
		}
	}
	return nil
}

func invalidElementIndexGroups(elements []decodedElement) [][]int {
	groups := make([][]int, 0)
	lowerBound, upperBound := "", ""
	lowerBoundIndex, upperBoundIndex := -1, 0
	getLowerBound := func(index int) (string, int) {
		cached := ""
		if lowerBoundIndex >= 0 && lowerBoundIndex < len(elements) {
			cached = elements[lowerBoundIndex].index
		}
		candidate := ""
		if index-1 >= 0 {
			candidate = elements[index-1].index
		}
		if (cached == "" && candidate != "") || (cached != "" && candidate != "" && candidate > cached) {
			return candidate, index - 1
		}
		return cached, lowerBoundIndex
	}
	getUpperBound := func(index int) (string, int) {
		cached := ""
		if upperBoundIndex >= 0 && upperBoundIndex < len(elements) {
			cached = elements[upperBoundIndex].index
		}
		if cached != "" && index < upperBoundIndex {
			return cached, upperBoundIndex
		}
		candidateIndex := upperBoundIndex
		for {
			candidateIndex++
			if candidateIndex >= len(elements) {
				return "", candidateIndex
			}
			candidate := elements[candidateIndex].index
			if (cached == "" && candidate != "") || (cached != "" && candidate != "" && candidate > cached) {
				return candidate, candidateIndex
			}
		}
	}
	for index := 0; index < len(elements); {
		lowerBound, lowerBoundIndex = getLowerBound(index)
		upperBound, upperBoundIndex = getUpperBound(index)
		if validFractionalIndex(elements[index].index, lowerBound, upperBound) {
			index++
			continue
		}
		group := []int{lowerBoundIndex, index}
		index++
		for index < len(elements) {
			nextLower, nextLowerIndex := getLowerBound(index)
			nextUpper, nextUpperIndex := getUpperBound(index)
			if validFractionalIndex(elements[index].index, nextLower, nextUpper) {
				break
			}
			lowerBound, lowerBoundIndex = nextLower, nextLowerIndex
			upperBound, upperBoundIndex = nextUpper, nextUpperIndex
			group = append(group, index)
			index++
		}
		group = append(group, upperBoundIndex)
		groups = append(groups, group)
	}
	return groups
}

func setDecodedElementIndex(element *decodedElement, index string, mutation elementIndexMutation) error {
	if element.version >= maxSafeJSONInteger {
		return fmt.Errorf("%w: element %s version cannot be incremented safely", ErrInvalidSceneElement, element.id)
	}
	versionNonce, updated, err := mutation(*element, index)
	if err != nil {
		return err
	}
	if versionNonce < 0 || versionNonce >= 1<<31 || updated < 0 || updated > maxSafeJSONInteger {
		return fmt.Errorf("invalid Excalidraw index mutation metadata")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(element.raw, &object); err != nil {
		return fmt.Errorf("decode element index update: %w", err)
	}
	encoded, _ := json.Marshal(index)
	object["index"] = encoded
	object["version"] = json.RawMessage(fmt.Sprintf("%d", element.version+1))
	object["versionNonce"] = json.RawMessage(fmt.Sprintf("%d", versionNonce))
	object["updated"] = json.RawMessage(fmt.Sprintf("%d", updated))
	raw, err := json.Marshal(object)
	if err != nil {
		return fmt.Errorf("encode element index update: %w", err)
	}
	element.index = index
	element.version++
	element.versionNonce = versionNonce
	element.raw = raw
	return nil
}
