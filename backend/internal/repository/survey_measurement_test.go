package repository

import (
	"math"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestCalculateMeasurementScoresNormalizesWeightsReverseAndMissingness(t *testing.T) {
	ratingID, choiceID := uuid.New(), uuid.New()
	questions := []*domain.SurveyQuestion{
		{ID: ratingID, Type: "rating", Config: domain.SurveyQuestionConfig{MaxRating: 5, Measurement: &domain.SurveyQuestionMeasurement{DimensionKey: "impacto", Weight: 1}}},
		{ID: choiceID, Type: "single_choice", Config: domain.SurveyQuestionConfig{Options: []string{"Sí", "No"}, Measurement: &domain.SurveyQuestionMeasurement{DimensionKey: "impacto", Weight: 1, Reverse: true, OptionScores: map[string]float64{"No": 0, "Sí": 10}}}},
	}
	config := domain.SurveyMeasurementConfig{Dimensions: []domain.SurveyMeasurementDimension{{Key: "impacto", Name: "Impacto", MinimumAnsweredRatio: 1}}}
	completeID, incompleteID := uuid.New(), uuid.New()
	answers := map[uuid.UUID]surveyMeasurementAnswerSet{
		completeID:   {Values: map[uuid.UUID]string{ratingID: "5", choiceID: "Sí"}},
		incompleteID: {Values: map[uuid.UUID]string{ratingID: "5"}},
	}
	scores, stats := calculateMeasurementScores(config, questions, answers)
	if got := scores[completeID]["impacto"]; math.Abs(got-50) > 0.001 {
		t.Fatalf("weighted normalized score=%v, want 50", got)
	}
	if _, exists := scores[incompleteID]; exists {
		t.Fatal("an incomplete response must not receive a score at a 100% threshold")
	}
	if len(stats) != 1 || stats[0].SampleSize != 1 || stats[0].Average == nil || math.Abs(*stats[0].Average-50) > 0.001 {
		t.Fatalf("unexpected dimension stats: %#v", stats)
	}
}

func TestPercentageKeepsUnavailableDenominatorsExplicit(t *testing.T) {
	if percentage(1, 0) != nil {
		t.Fatal("a rate without a denominator must be unavailable")
	}
	value := percentage(1, 4)
	if value == nil || *value != 25 {
		t.Fatalf("percentage=%v, want 25", value)
	}
}

func TestCalculateMeasurementScoresExcludesQuestionsSkippedByConditionalLogic(t *testing.T) {
	firstID, skippedID, finalID := uuid.New(), uuid.New(), uuid.New()
	questions := []*domain.SurveyQuestion{
		{ID: firstID, OrderIndex: 0, Type: "single_choice", Config: domain.SurveyQuestionConfig{Options: []string{"Saltar", "Continuar"}}, LogicRules: []domain.SurveyLogicRule{{Value: "Saltar", JumpTo: finalID}}},
		{ID: skippedID, OrderIndex: 1, Type: "rating", Config: domain.SurveyQuestionConfig{MaxRating: 5, Measurement: &domain.SurveyQuestionMeasurement{DimensionKey: "bienestar", Weight: 1}}},
		{ID: finalID, OrderIndex: 2, Type: "rating", Config: domain.SurveyQuestionConfig{MaxRating: 5, Measurement: &domain.SurveyQuestionMeasurement{DimensionKey: "bienestar", Weight: 1}}},
	}
	config := domain.SurveyMeasurementConfig{Dimensions: []domain.SurveyMeasurementDimension{{Key: "bienestar", Name: "Bienestar", MinimumAnsweredRatio: 1}}}
	responseID := uuid.New()
	answers := map[uuid.UUID]surveyMeasurementAnswerSet{
		responseID: {Values: map[uuid.UUID]string{firstID: "Saltar", finalID: "5"}},
	}
	scores, _ := calculateMeasurementScores(config, questions, answers)
	if got := scores[responseID]["bienestar"]; math.Abs(got-100) > 0.001 {
		t.Fatalf("conditional score=%v, want 100 without the skipped question in the denominator", got)
	}
}
