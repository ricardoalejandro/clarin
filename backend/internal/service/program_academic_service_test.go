package service

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestValidateCourseAggregateNormalizesOrderedTopics(t *testing.T) {
	description := "  reusable plan  "
	emptyDescription := "   "
	course := &domain.Course{
		Name:        "  Filosofía práctica  ",
		Description: &description,
		Topics: []*domain.CourseTopic{
			{Title: "  Tema uno  ", Description: &emptyDescription},
			{Title: "Tema dos", Status: "archived", Position: 99},
		},
	}

	if err := validateCourseAggregate(course); err != nil {
		t.Fatalf("validate aggregate: %v", err)
	}
	if course.Name != "Filosofía práctica" || course.Status != "active" {
		t.Fatalf("unexpected normalized course: %#v", course)
	}
	if course.Description == nil || *course.Description != "reusable plan" {
		t.Fatalf("unexpected description: %#v", course.Description)
	}
	if got := course.Topics[0]; got.Title != "Tema uno" || got.Description != nil || got.Status != "active" || got.Position != 0 {
		t.Fatalf("unexpected first topic: %#v", got)
	}
	if got := course.Topics[1]; got.Status != "archived" || got.Position != 1 {
		t.Fatalf("unexpected second topic: %#v", got)
	}
}

func TestValidateCourseAggregateRejectsInvalidTopics(t *testing.T) {
	duplicateID := uuid.New()
	cases := []struct {
		name   string
		course *domain.Course
	}{
		{name: "missing course name", course: &domain.Course{}},
		{name: "missing topic title", course: &domain.Course{Name: "Plan", Topics: []*domain.CourseTopic{{Title: " "}}}},
		{name: "invalid topic status", course: &domain.Course{Name: "Plan", Topics: []*domain.CourseTopic{{Title: "Tema", Status: "deleted"}}}},
		{name: "duplicate topic id", course: &domain.Course{Name: "Plan", Topics: []*domain.CourseTopic{{ID: duplicateID, Title: "Uno"}, {ID: duplicateID, Title: "Dos"}}}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if err := validateCourseAggregate(test.course); !errors.Is(err, ErrProgramInput) {
				t.Fatalf("expected ErrProgramInput, got %v", err)
			}
		})
	}
}

func TestAcademicMutationsRequireOptimisticVersion(t *testing.T) {
	service := &ProgramService{}
	course := &domain.Course{ID: uuid.New(), Name: "Plan"}
	if err := service.UpdateCourse(t.Context(), course); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected course update version error, got %v", err)
	}
	if _, err := service.DeleteCourse(t.Context(), uuid.New(), uuid.New(), time.Time{}); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected course delete version error, got %v", err)
	}
	if _, err := service.ReplaceProgramCourses(t.Context(), uuid.New(), uuid.New(), nil, nil); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected program course version error, got %v", err)
	}
	if _, err := service.ReplaceProgramInstructors(t.Context(), uuid.New(), uuid.New(), nil, nil); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected instructor version error, got %v", err)
	}
	if _, err := service.ReplaceAcademicConfig(t.Context(), uuid.New(), uuid.New(), nil, nil, nil); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected atomic academic config version error, got %v", err)
	}
}

func TestListCoursesValidatesBoundedPagination(t *testing.T) {
	service := &ProgramService{}
	if _, _, err := service.ListCourses(t.Context(), uuid.New(), "active", "", 0, 10); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected invalid page to be rejected, got %v", err)
	}
	if _, _, err := service.ListCourses(t.Context(), uuid.New(), "active", "", 1, 101); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected oversized page to be rejected, got %v", err)
	}
	if _, _, err := service.ListCourses(t.Context(), uuid.New(), "active", strings.Repeat("a", 161), 1, 10); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected oversized search to be rejected, got %v", err)
	}
}

func TestNormalizeParticipantEnrollmentDateKeepsPastDateAndRejectsFuture(t *testing.T) {
	now := time.Date(2026, time.July, 22, 23, 30, 0, 0, time.FixedZone("PET", -5*60*60))
	past := time.Date(2026, time.July, 15, 18, 45, 0, 0, time.FixedZone("PET", -5*60*60))
	normalized, err := normalizeParticipantEnrollmentDate(past, now)
	if err != nil {
		t.Fatalf("past enrollment date should be valid: %v", err)
	}
	if got := normalized.Format(time.RFC3339); got != "2026-07-15T00:00:00Z" {
		t.Fatalf("normalized enrollment = %s", got)
	}

	future := time.Date(2026, time.July, 24, 0, 0, 0, 0, time.UTC)
	if _, err := normalizeParticipantEnrollmentDate(future, now); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("future enrollment must be an input error, got %v", err)
	}
}

func TestBuildRecurringSessionDraftsUsesSelectedWeekdays(t *testing.T) {
	programID := uuid.New()
	start := time.Date(2026, time.July, 20, 0, 0, 0, 0, time.UTC) // Monday
	end := time.Date(2026, time.July, 26, 0, 0, 0, 0, time.UTC)   // Sunday
	location := "Aula 2"

	sessions, err := buildRecurringSessionDrafts(programID, start, end, []int{1, 3, 5}, "18:00", "19:30", " ", &location)
	if err != nil {
		t.Fatalf("build sessions: %v", err)
	}
	if len(sessions) != 3 {
		t.Fatalf("expected 3 sessions, got %d", len(sessions))
	}
	wantDates := []string{"2026-07-20", "2026-07-22", "2026-07-24"}
	wantTopics := []string{"Sesión 1", "Sesión 2", "Sesión 3"}
	for index, session := range sessions {
		if got := session.Date.Format("2006-01-02"); got != wantDates[index] {
			t.Fatalf("session %d date: got %s, want %s", index, got, wantDates[index])
		}
		wantTopic := wantTopics[index]
		if session.Title != wantTopic {
			t.Fatalf("session %d title: got %q, want %q", index, session.Title, wantTopic)
		}
		if session.Topic == nil || *session.Topic != wantTopic {
			t.Fatalf("session %d topic: %#v, want %q", index, session.Topic, wantTopic)
		}
		if session.StartTime == nil || *session.StartTime != "18:00" || session.EndTime == nil || *session.EndTime != "19:30" {
			t.Fatalf("session %d times were not preserved", index)
		}
	}
}

func TestGenerateSessionsClassifiesScheduleValidationAsInputError(t *testing.T) {
	service := &ProgramService{}
	_, err := service.GenerateSessions(
		t.Context(),
		uuid.New(),
		uuid.New(),
		time.Date(2026, time.July, 22, 0, 0, 0, 0, time.UTC),
		time.Date(2026, time.July, 21, 0, 0, 0, 0, time.UTC),
		[]int{1},
		"09:00",
		"10:00",
		"Sesión",
		nil,
		false,
	)
	if !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected ErrProgramInput, got %v", err)
	}
}

func TestBuildRecurringSessionDraftsLimitsRangeAndVolume(t *testing.T) {
	programID := uuid.New()
	start := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)
	allDays := []int{0, 1, 2, 3, 4, 5, 6}

	if _, err := buildRecurringSessionDrafts(programID, start, start.AddDate(2, 0, 1), []int{1}, "", "", "", nil); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected overlong range to be rejected, got %v", err)
	}
	if _, err := buildRecurringSessionDrafts(programID, start, start.AddDate(1, 6, 0), allDays, "", "", "", nil); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected oversized schedule to be rejected, got %v", err)
	}
	if _, err := buildRecurringSessionDrafts(programID, start, start, []int{4}, "", "", strings.Repeat("a", 252), nil); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected an oversized topic prefix to be rejected, got %v", err)
	}
	if _, err := buildRecurringSessionDrafts(programID, start, start, []int{4}, "9am", "", "", nil); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected an invalid start time to be rejected, got %v", err)
	}
	if _, err := buildRecurringSessionDrafts(programID, start, start, []int{4}, "10:00", "09:00", "", nil); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected an end time before the start time to be rejected, got %v", err)
	}
	longLocation := strings.Repeat("a", 501)
	if _, err := buildRecurringSessionDrafts(programID, start, start, []int{4}, "", "", "", &longLocation); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected an oversized location to be rejected, got %v", err)
	}
}

func TestValidateSessionAllowsLinkedTopicAndRequiresFreeText(t *testing.T) {
	topicID := uuid.New()
	linked := &domain.ProgramSession{CourseTopicID: &topicID}
	if err := validateSession(linked); err != nil {
		t.Fatalf("linked topic should supply the canonical title later: %v", err)
	}
	if linked.SessionType != "regular" {
		t.Fatalf("expected regular default, got %q", linked.SessionType)
	}

	empty := "   "
	if err := validateSession(&domain.ProgramSession{Topic: &empty}); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected empty free topic to be rejected, got %v", err)
	}

	topic := "Tema libre"
	invalidStart, invalidEnd := "18:00", "17:59"
	if err := validateSession(&domain.ProgramSession{Topic: &topic, StartTime: &invalidStart, EndTime: &invalidEnd}); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected invalid individual session times to be rejected, got %v", err)
	}
}

func TestValidateSessionNormalizesIndependentTitleCompatibly(t *testing.T) {
	legacyTopic := "  Tema heredado  "
	created := &domain.ProgramSession{Topic: &legacyTopic}
	if err := validateSession(created); err != nil {
		t.Fatalf("validate legacy create: %v", err)
	}
	if created.Title != "" || created.TitleProvided {
		t.Fatalf("legacy create must defer title derivation until canonical topics resolve: %#v", created)
	}

	freeTopic := "Contenido"
	independent := &domain.ProgramSession{
		Title:         "  Clase de apertura  ",
		TitleProvided: true,
		Topic:         &freeTopic,
	}
	if err := validateSession(independent); err != nil {
		t.Fatalf("validate independent title: %v", err)
	}
	if independent.Title != "Clase de apertura" || independent.Topics[0].TopicTitleSnapshot != freeTopic {
		t.Fatalf("title and topic were not kept independent: %#v", independent)
	}

	updateWithoutTitle := &domain.ProgramSession{ID: uuid.New(), Topic: &freeTopic}
	if err := validateSession(updateWithoutTitle); err != nil {
		t.Fatalf("validate update without title: %v", err)
	}
	if updateWithoutTitle.Title != "" || updateWithoutTitle.TitleProvided {
		t.Fatalf("omitted update title must be preserved by repository, got %#v", updateWithoutTitle)
	}

	blank := &domain.ProgramSession{TitleProvided: true, Topic: &freeTopic}
	if err := validateSession(blank); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected explicit blank title to be rejected, got %v", err)
	}
	overlong := &domain.ProgramSession{Title: strings.Repeat("a", 256), TitleProvided: true, Topic: &freeTopic}
	if err := validateSession(overlong); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected oversized title to be rejected, got %v", err)
	}
}

func TestValidateSessionAcceptsOneTopicPerDifferentCourse(t *testing.T) {
	firstTopicID := uuid.New()
	secondTopicID := uuid.New()
	session := &domain.ProgramSession{Topics: []*domain.ProgramSessionTopic{
		{Kind: "course", CourseTopicID: &firstTopicID},
		{Kind: "course", CourseTopicID: &secondTopicID},
	}}

	if err := validateSession(session); err != nil {
		t.Fatalf("topics from different courses are resolved transactionally later and should pass shape validation: %v", err)
	}
	for position, topic := range session.Topics {
		if topic.Position != position {
			t.Fatalf("topic %d position: got %d", position, topic.Position)
		}
	}
}

func TestValidateSessionRejectsInvalidTopicCombinations(t *testing.T) {
	topicID := uuid.New()
	otherTopicID := uuid.New()
	tests := []struct {
		name   string
		topics []*domain.ProgramSessionTopic
	}{
		{
			name: "course and free topic",
			topics: []*domain.ProgramSessionTopic{
				{Kind: "course", CourseTopicID: &topicID},
				{Kind: "free", TopicTitleSnapshot: "Conversatorio"},
			},
		},
		{
			name: "two free topics",
			topics: []*domain.ProgramSessionTopic{
				{Kind: "free", TopicTitleSnapshot: "Uno"},
				{Kind: "free", TopicTitleSnapshot: "Dos"},
			},
		},
		{
			name: "duplicate course topic",
			topics: []*domain.ProgramSessionTopic{
				{Kind: "course", CourseTopicID: &topicID},
				{Kind: "course", CourseTopicID: &topicID},
			},
		},
		{
			name: "unknown kind",
			topics: []*domain.ProgramSessionTopic{
				{Kind: "other", CourseTopicID: &otherTopicID},
			},
		},
		{
			name: "empty free topic",
			topics: []*domain.ProgramSessionTopic{
				{Kind: "free", TopicTitleSnapshot: "  "},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := validateSession(&domain.ProgramSession{Topics: test.topics}); !errors.Is(err, ErrProgramInput) {
				t.Fatalf("expected ErrProgramInput, got %v", err)
			}
		})
	}
}
