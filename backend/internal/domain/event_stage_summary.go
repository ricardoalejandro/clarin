package domain

import "github.com/google/uuid"

// EventStageSummary identifies stages by ID, preserving equal names and Sin etapa.
type EventStageSummary struct {
	ID       *uuid.UUID `json:"id"`
	Name     string     `json:"name"`
	Color    string     `json:"color"`
	Position int        `json:"position"`
	Count    int        `json:"count"`
}
