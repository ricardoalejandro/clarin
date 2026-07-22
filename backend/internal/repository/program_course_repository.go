package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var (
	ErrCourseNotFound         = errors.New("course not found")
	ErrCourseConflict         = errors.New("course was modified by another user; reload it before saving")
	ErrAcademicConfigConflict = errors.New("program configuration was modified by another user; reload it before saving")
	ErrProgramNotFound        = errors.New("program not found")
	ErrProgramNotCourse       = errors.New("academic configuration only applies to course-type programs")
	ErrInvalidCourseTopic     = errors.New("course topic does not belong to this course")
	ErrInvalidProgramCourse   = errors.New("course is not available for this account")
	ErrInvalidInstructor      = errors.New("instructor must be a non-group contact from this account")
	ErrInvalidSessionTopic    = errors.New("course topic must be active and assigned to this program")
	ErrSessionNotFound        = errors.New("session not found")
)

type CourseDeleteResult struct {
	Deleted  bool           `json:"deleted"`
	Archived bool           `json:"archived"`
	Course   *domain.Course `json:"course,omitempty"`
}

// CreateCourse creates the course and its complete ordered topic plan in one
// transaction.
func (r *ProgramRepository) CreateCourse(ctx context.Context, course *domain.Course) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	err = tx.QueryRow(ctx, `
		INSERT INTO courses (account_id, name, description, status)
		VALUES ($1, $2, $3, $4)
		RETURNING id, created_at, updated_at
	`, course.AccountID, course.Name, course.Description, course.Status).Scan(&course.ID, &course.CreatedAt, &course.UpdatedAt)
	if err != nil {
		return err
	}

	for position, topic := range course.Topics {
		topic.AccountID = course.AccountID
		topic.CourseID = course.ID
		topic.Position = position
		err = tx.QueryRow(ctx, `
			INSERT INTO course_topics (account_id, course_id, title, description, status, position)
			VALUES ($1, $2, $3, $4, $5, $6)
			RETURNING id, created_at, updated_at
		`, topic.AccountID, topic.CourseID, topic.Title, topic.Description, topic.Status, topic.Position).
			Scan(&topic.ID, &topic.CreatedAt, &topic.UpdatedAt)
		if err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

// ListCourses returns lightweight summaries. Topic aggregates are loaded only
// by GetCourse or academic-config, keeping catalog pagination bounded even
// when plans contain hundreds of topics.
func (r *ProgramRepository) ListCourses(ctx context.Context, accountID uuid.UUID, status, search string, limit, offset int) ([]*domain.Course, int, error) {
	query := `
		WITH program_usage AS (
			SELECT account_id, course_id, COUNT(*)::int AS usage_count
			FROM program_courses
			WHERE account_id = $1
			GROUP BY account_id, course_id
		), session_usage AS (
			SELECT pst.account_id, pst.course_id, COUNT(*)::int AS usage_count
			FROM program_session_topics pst
			WHERE pst.account_id = $1 AND pst.kind = 'course'
			GROUP BY pst.account_id, pst.course_id
		), topic_counts AS (
			SELECT account_id, course_id, COUNT(*)::int AS topic_count,
			       COUNT(*) FILTER (WHERE status = 'active')::int AS active_topic_count
			FROM course_topics
			WHERE account_id = $1
			GROUP BY account_id, course_id
		)
		SELECT c.id, c.account_id, c.name, c.description, c.status,
		       0 AS position,
		       COALESCE(pu.usage_count, 0) + COALESCE(su.usage_count, 0) AS usage_count,
		       COALESCE(tc.topic_count, 0), COALESCE(tc.active_topic_count, 0),
		       ARRAY(
		           SELECT preview.title FROM course_topics preview
		           WHERE preview.account_id = c.account_id AND preview.course_id = c.id AND preview.status = 'active'
		           ORDER BY preview.position, preview.created_at
		           LIMIT 3
		       ) AS topic_preview,
		       c.created_at, c.updated_at, COUNT(*) OVER()::int AS total_count
		FROM courses c
		LEFT JOIN program_usage pu ON pu.account_id = c.account_id AND pu.course_id = c.id
		LEFT JOIN session_usage su ON su.account_id = c.account_id AND su.course_id = c.id
		LEFT JOIN topic_counts tc ON tc.account_id = c.account_id AND tc.course_id = c.id
		WHERE c.account_id = $1`
	args := []any{accountID}
	if status != "" {
		args = append(args, status)
		query += fmt.Sprintf(" AND c.status = $%d", len(args))
	}
	if search != "" {
		args = append(args, search)
		query += fmt.Sprintf(" AND (c.name ILIKE '%%' || $%d || '%%' OR COALESCE(c.description, '') ILIKE '%%' || $%d || '%%')", len(args), len(args))
	}
	args = append(args, limit, offset)
	query += fmt.Sprintf(" ORDER BY CASE WHEN c.status = 'active' THEN 0 ELSE 1 END, LOWER(c.name), c.created_at DESC LIMIT $%d OFFSET $%d", len(args)-1, len(args))

	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	courses := make([]*domain.Course, 0)
	total := 0
	for rows.Next() {
		course := &domain.Course{Topics: make([]*domain.CourseTopic, 0), TopicPreview: make([]string, 0)}
		if err := rows.Scan(
			&course.ID, &course.AccountID, &course.Name, &course.Description, &course.Status,
			&course.Position, &course.UsageCount, &course.TopicCount, &course.ActiveTopicCount, &course.TopicPreview,
			&course.CreatedAt, &course.UpdatedAt, &total,
		); err != nil {
			return nil, 0, err
		}
		courses = append(courses, course)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return courses, total, nil
}

func (r *ProgramRepository) GetCourse(ctx context.Context, accountID, courseID uuid.UUID) (*domain.Course, error) {
	course := &domain.Course{}
	err := r.db.QueryRow(ctx, `
		WITH program_usage AS (
			SELECT COUNT(*)::int AS usage_count
			FROM program_courses
			WHERE account_id = $1 AND course_id = $2
		), session_usage AS (
			SELECT COUNT(*)::int AS usage_count
			FROM program_session_topics pst
			WHERE pst.account_id = $1 AND pst.course_id = $2 AND pst.kind = 'course'
		)
		SELECT c.id, c.account_id, c.name, c.description, c.status,
		       0 AS position,
		       (SELECT usage_count FROM program_usage) + (SELECT usage_count FROM session_usage),
		       c.created_at, c.updated_at
		FROM courses c
		WHERE c.account_id = $1 AND c.id = $2
	`, accountID, courseID).Scan(
		&course.ID, &course.AccountID, &course.Name, &course.Description, &course.Status,
		&course.Position, &course.UsageCount, &course.CreatedAt, &course.UpdatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := r.loadCourseTopics(ctx, accountID, []*domain.Course{course}); err != nil {
		return nil, err
	}
	return course, nil
}

func (r *ProgramRepository) loadCourseTopics(ctx context.Context, accountID uuid.UUID, courses []*domain.Course) error {
	if len(courses) == 0 {
		return nil
	}
	courseIDs := make([]uuid.UUID, 0, len(courses))
	byID := make(map[uuid.UUID]*domain.Course, len(courses))
	for _, course := range courses {
		course.Topics = make([]*domain.CourseTopic, 0)
		courseIDs = append(courseIDs, course.ID)
		byID[course.ID] = course
	}

	rows, err := r.db.Query(ctx, `
		SELECT ct.id, ct.account_id, ct.course_id, ct.title, ct.description, ct.status,
		       ct.position, COUNT(pst.id)::int AS usage_count, ct.created_at, ct.updated_at
		FROM course_topics ct
		LEFT JOIN program_session_topics pst ON pst.account_id = ct.account_id AND pst.course_topic_id = ct.id
		WHERE ct.account_id = $1 AND ct.course_id = ANY($2::uuid[])
		GROUP BY ct.id
		ORDER BY ct.course_id, ct.position, ct.created_at
	`, accountID, courseIDs)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		topic := &domain.CourseTopic{}
		if err := rows.Scan(
			&topic.ID, &topic.AccountID, &topic.CourseID, &topic.Title, &topic.Description,
			&topic.Status, &topic.Position, &topic.UsageCount, &topic.CreatedAt, &topic.UpdatedAt,
		); err != nil {
			return err
		}
		if course := byID[topic.CourseID]; course != nil {
			course.Topics = append(course.Topics, topic)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, course := range courses {
		course.TopicCount = len(course.Topics)
		course.ActiveTopicCount = 0
		course.TopicPreview = make([]string, 0, 3)
		for _, topic := range course.Topics {
			if topic.Status == "active" {
				course.ActiveTopicCount++
				if len(course.TopicPreview) < 3 {
					course.TopicPreview = append(course.TopicPreview, topic.Title)
				}
			}
		}
	}
	return nil
}

// UpdateCourse treats Topics as the complete desired topic list. Removed
// topics that already belong to a historical session are archived; topics
// without any use are physically removed.
func (r *ProgramRepository) UpdateCourse(ctx context.Context, course *domain.Course) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var lockedCourseID uuid.UUID
	var currentUpdatedAt time.Time
	if err := tx.QueryRow(ctx, `
		SELECT id, updated_at FROM courses WHERE account_id = $1 AND id = $2 FOR UPDATE
	`, course.AccountID, course.ID).Scan(&lockedCourseID, &currentUpdatedAt); err != nil {
		if err == pgx.ErrNoRows {
			return ErrCourseNotFound
		}
		return err
	}
	if course.ExpectedUpdatedAt == nil || !currentUpdatedAt.Equal(*course.ExpectedUpdatedAt) {
		return ErrCourseConflict
	}

	if _, err := tx.Exec(ctx, `
		UPDATE courses
		SET name = $1, description = $2, status = $3, updated_at = NOW()
		WHERE account_id = $4 AND id = $5
	`, course.Name, course.Description, course.Status, course.AccountID, course.ID); err != nil {
		return err
	}

	existingRows, err := tx.Query(ctx, `
		SELECT id FROM course_topics
		WHERE account_id = $1 AND course_id = $2
		FOR UPDATE
	`, course.AccountID, course.ID)
	if err != nil {
		return err
	}
	existing := make(map[uuid.UUID]struct{})
	for existingRows.Next() {
		var id uuid.UUID
		if err := existingRows.Scan(&id); err != nil {
			existingRows.Close()
			return err
		}
		existing[id] = struct{}{}
	}
	if err := existingRows.Err(); err != nil {
		existingRows.Close()
		return err
	}
	existingRows.Close()

	seen := make(map[uuid.UUID]struct{}, len(course.Topics))
	for position, topic := range course.Topics {
		topic.AccountID = course.AccountID
		topic.CourseID = course.ID
		topic.Position = position
		if topic.ID == uuid.Nil {
			if err := tx.QueryRow(ctx, `
				INSERT INTO course_topics (account_id, course_id, title, description, status, position)
				VALUES ($1, $2, $3, $4, $5, $6)
				RETURNING id, created_at, updated_at
			`, topic.AccountID, topic.CourseID, topic.Title, topic.Description, topic.Status, topic.Position).
				Scan(&topic.ID, &topic.CreatedAt, &topic.UpdatedAt); err != nil {
				return err
			}
			seen[topic.ID] = struct{}{}
			continue
		}
		if _, ok := existing[topic.ID]; !ok {
			return ErrInvalidCourseTopic
		}
		if _, duplicate := seen[topic.ID]; duplicate {
			return ErrInvalidCourseTopic
		}
		seen[topic.ID] = struct{}{}
		if _, err := tx.Exec(ctx, `
			UPDATE course_topics
			SET title = $1, description = $2, status = $3, position = $4, updated_at = NOW()
			WHERE account_id = $5 AND course_id = $6 AND id = $7
		`, topic.Title, topic.Description, topic.Status, topic.Position, course.AccountID, course.ID, topic.ID); err != nil {
			return err
		}
	}

	omittedIDs := make([]uuid.UUID, 0)
	for topicID := range existing {
		if _, keep := seen[topicID]; !keep {
			omittedIDs = append(omittedIDs, topicID)
		}
	}
	if len(omittedIDs) > 0 {
		used := make(map[uuid.UUID]struct{}, len(omittedIDs))
		usageRows, err := tx.Query(ctx, `
			SELECT course_topic_id
			FROM program_session_topics
			WHERE account_id = $1 AND course_topic_id = ANY($2::uuid[])
			GROUP BY course_topic_id
		`, course.AccountID, omittedIDs)
		if err != nil {
			return err
		}
		for usageRows.Next() {
			var topicID uuid.UUID
			if err := usageRows.Scan(&topicID); err != nil {
				usageRows.Close()
				return err
			}
			used[topicID] = struct{}{}
		}
		if err := usageRows.Err(); err != nil {
			usageRows.Close()
			return err
		}
		usageRows.Close()

		usedIDs := make([]uuid.UUID, 0, len(used))
		unusedIDs := make([]uuid.UUID, 0, len(omittedIDs)-len(used))
		for _, topicID := range omittedIDs {
			if _, isUsed := used[topicID]; isUsed {
				usedIDs = append(usedIDs, topicID)
			} else {
				unusedIDs = append(unusedIDs, topicID)
			}
		}
		if len(usedIDs) > 0 {
			if _, err := tx.Exec(ctx, `
				UPDATE course_topics SET status = 'archived', updated_at = NOW()
				WHERE account_id = $1 AND course_id = $2 AND id = ANY($3::uuid[])
			`, course.AccountID, course.ID, usedIDs); err != nil {
				return err
			}
		}
		if len(unusedIDs) > 0 {
			if _, err := tx.Exec(ctx, `
				DELETE FROM course_topics
				WHERE account_id = $1 AND course_id = $2 AND id = ANY($3::uuid[])
			`, course.AccountID, course.ID, unusedIDs); err != nil {
				return err
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}
	refreshed, err := r.GetCourse(ctx, course.AccountID, course.ID)
	if err != nil {
		return err
	}
	if refreshed == nil {
		return ErrCourseNotFound
	}
	*course = *refreshed
	return nil
}

func (r *ProgramRepository) DeleteCourse(ctx context.Context, accountID, courseID uuid.UUID, expectedUpdatedAt time.Time) (*CourseDeleteResult, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var lockedCourseID uuid.UUID
	var currentUpdatedAt time.Time
	if err := tx.QueryRow(ctx, `
		SELECT id, updated_at FROM courses WHERE account_id = $1 AND id = $2 FOR UPDATE
	`, accountID, courseID).Scan(&lockedCourseID, &currentUpdatedAt); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrCourseNotFound
		}
		return nil, err
	}
	if expectedUpdatedAt.IsZero() || !currentUpdatedAt.Equal(expectedUpdatedAt) {
		return nil, ErrCourseConflict
	}

	var usageCount int
	if err := tx.QueryRow(ctx, `
		SELECT
			(SELECT COUNT(*) FROM program_courses WHERE account_id = $1 AND course_id = $2) +
			(SELECT COUNT(*) FROM program_session_topics pst
			 WHERE pst.account_id = $1 AND pst.course_id = $2 AND pst.kind = 'course')
	`, accountID, courseID).Scan(&usageCount); err != nil {
		return nil, err
	}

	result := &CourseDeleteResult{}
	if usageCount == 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM courses WHERE account_id = $1 AND id = $2`, accountID, courseID); err != nil {
			return nil, err
		}
		result.Deleted = true
	} else {
		if _, err := tx.Exec(ctx, `
			UPDATE courses SET status = 'archived', updated_at = NOW()
			WHERE account_id = $1 AND id = $2
		`, accountID, courseID); err != nil {
			return nil, err
		}
		result.Archived = true
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if result.Archived {
		result.Course, err = r.GetCourse(ctx, accountID, courseID)
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}

func (r *ProgramRepository) GetAcademicConfig(ctx context.Context, accountID, programID uuid.UUID) (*domain.ProgramAcademicConfig, error) {
	if err := r.requireCourseProgram(ctx, r.db, accountID, programID, false); err != nil {
		return nil, err
	}
	var configUpdatedAt time.Time
	if err := r.db.QueryRow(ctx, `
		SELECT updated_at FROM programs WHERE account_id = $1 AND id = $2
	`, accountID, programID).Scan(&configUpdatedAt); err != nil {
		return nil, err
	}

	rows, err := r.db.Query(ctx, `
		WITH program_usage AS (
			SELECT account_id, course_id, COUNT(*)::int AS usage_count
			FROM program_courses
			WHERE account_id = $1
			GROUP BY account_id, course_id
		), session_usage AS (
			SELECT pst.account_id, pst.course_id, COUNT(*)::int AS usage_count
			FROM program_session_topics pst
			WHERE pst.account_id = $1 AND pst.kind = 'course'
			GROUP BY pst.account_id, pst.course_id
		)
		SELECT c.id, c.account_id, c.name, c.description, c.status, pc.position,
		       COALESCE(pu.usage_count, 0) + COALESCE(su.usage_count, 0),
		       c.created_at, c.updated_at
		FROM program_courses pc
		JOIN courses c ON c.account_id = pc.account_id AND c.id = pc.course_id
		LEFT JOIN program_usage pu ON pu.account_id = c.account_id AND pu.course_id = c.id
		LEFT JOIN session_usage su ON su.account_id = c.account_id AND su.course_id = c.id
		WHERE pc.account_id = $1 AND pc.program_id = $2
		ORDER BY pc.position, pc.created_at
	`, accountID, programID)
	if err != nil {
		return nil, err
	}
	courses := make([]*domain.Course, 0)
	for rows.Next() {
		course := &domain.Course{}
		if err := rows.Scan(
			&course.ID, &course.AccountID, &course.Name, &course.Description, &course.Status,
			&course.Position, &course.UsageCount, &course.CreatedAt, &course.UpdatedAt,
		); err != nil {
			rows.Close()
			return nil, err
		}
		courses = append(courses, course)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if err := r.loadCourseTopics(ctx, accountID, courses); err != nil {
		return nil, err
	}

	instructorRows, err := r.db.Query(ctx, `
		SELECT pi.contact_id,
		       COALESCE(c.custom_name, c.name, c.push_name, c.phone, ''),
		       c.phone, c.avatar_url, COALESCE(c.avatar_revision, 0), pi.position
		FROM program_instructors pi
		JOIN contacts c ON c.account_id = pi.account_id AND c.id = pi.contact_id
		WHERE pi.account_id = $1 AND pi.program_id = $2 AND COALESCE(c.is_group, FALSE) = FALSE
		ORDER BY pi.position, pi.created_at
	`, accountID, programID)
	if err != nil {
		return nil, err
	}
	defer instructorRows.Close()
	instructors := make([]*domain.ProgramInstructor, 0)
	for instructorRows.Next() {
		instructor := &domain.ProgramInstructor{}
		if err := instructorRows.Scan(
			&instructor.ContactID, &instructor.ContactName, &instructor.ContactPhone,
			&instructor.AvatarURL, &instructor.AvatarRevision, &instructor.Position,
		); err != nil {
			return nil, err
		}
		instructors = append(instructors, instructor)
	}
	if err := instructorRows.Err(); err != nil {
		return nil, err
	}

	return &domain.ProgramAcademicConfig{
		ProgramID:   programID,
		UpdatedAt:   configUpdatedAt,
		Courses:     courses,
		Instructors: instructors,
	}, nil
}

// ReplaceAcademicConfig atomically replaces the ordered course plans and
// instructor Contacts assigned to a program. The optimistic version belongs
// to the program aggregate, so a stale browser can never overwrite a newer
// configuration.
func (r *ProgramRepository) ReplaceAcademicConfig(ctx context.Context, accountID, programID uuid.UUID, courseIDs, contactIDs []uuid.UUID, expectedUpdatedAt time.Time) (*domain.ProgramAcademicConfig, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := r.requireCourseProgram(ctx, tx, accountID, programID, true); err != nil {
		return nil, err
	}
	if err := requireProgramConfigVersion(ctx, tx, accountID, programID, expectedUpdatedAt); err != nil {
		return nil, err
	}
	if hasDuplicateUUIDs(courseIDs) {
		return nil, ErrInvalidProgramCourse
	}
	if hasDuplicateUUIDs(contactIDs) {
		return nil, ErrInvalidInstructor
	}

	// Archived plans that are already assigned may remain so historical
	// programs stay editable. A newly assigned plan must still be active.
	existingCourses := make(map[uuid.UUID]struct{})
	rows, err := tx.Query(ctx, `
		SELECT course_id FROM program_courses
		WHERE account_id = $1 AND program_id = $2
	`, accountID, programID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var courseID uuid.UUID
		if err := rows.Scan(&courseID); err != nil {
			rows.Close()
			return nil, err
		}
		existingCourses[courseID] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	if len(courseIDs) > 0 {
		statuses := make(map[uuid.UUID]string, len(courseIDs))
		rows, err = tx.Query(ctx, `
			SELECT id, status FROM courses
			WHERE account_id = $1 AND id = ANY($2::uuid[])
			FOR SHARE
		`, accountID, courseIDs)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id uuid.UUID
			var status string
			if err := rows.Scan(&id, &status); err != nil {
				rows.Close()
				return nil, err
			}
			statuses[id] = status
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
		for _, courseID := range courseIDs {
			status, found := statuses[courseID]
			if !found {
				return nil, ErrInvalidProgramCourse
			}
			if status != "active" {
				if _, alreadyAssigned := existingCourses[courseID]; !alreadyAssigned {
					return nil, ErrInvalidProgramCourse
				}
			}
		}
	}

	if len(contactIDs) > 0 {
		validContacts := make(map[uuid.UUID]struct{}, len(contactIDs))
		rows, err = tx.Query(ctx, `
			SELECT id FROM contacts
			WHERE account_id = $1 AND id = ANY($2::uuid[])
			  AND COALESCE(is_group, FALSE) = FALSE
			FOR SHARE
		`, accountID, contactIDs)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			validContacts[id] = struct{}{}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
		for _, contactID := range contactIDs {
			if _, found := validContacts[contactID]; !found {
				return nil, ErrInvalidInstructor
			}
		}
	}

	if _, err := tx.Exec(ctx, `
		DELETE FROM program_courses WHERE account_id = $1 AND program_id = $2
	`, accountID, programID); err != nil {
		return nil, err
	}
	if len(courseIDs) > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO program_courses (account_id, program_id, course_id, position)
			SELECT $1::uuid, $2::uuid, ordered.course_id, (ordered.ordinality - 1)::int
			FROM unnest($3::uuid[]) WITH ORDINALITY AS ordered(course_id, ordinality)
		`, accountID, programID, courseIDs); err != nil {
			return nil, err
		}
	}

	if _, err := tx.Exec(ctx, `
		DELETE FROM program_instructors WHERE account_id = $1 AND program_id = $2
	`, accountID, programID); err != nil {
		return nil, err
	}
	if len(contactIDs) > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO program_instructors (account_id, program_id, contact_id, position)
			SELECT $1::uuid, $2::uuid, ordered.contact_id, (ordered.ordinality - 1)::int
			FROM unnest($3::uuid[]) WITH ORDINALITY AS ordered(contact_id, ordinality)
		`, accountID, programID, contactIDs); err != nil {
			return nil, err
		}
	}

	if _, err := tx.Exec(ctx, `
		UPDATE programs SET updated_at = NOW() WHERE account_id = $1 AND id = $2
	`, accountID, programID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetAcademicConfig(ctx, accountID, programID)
}

func (r *ProgramRepository) ReplaceProgramCourses(ctx context.Context, accountID, programID uuid.UUID, courseIDs []uuid.UUID, expectedUpdatedAt time.Time) (*domain.ProgramAcademicConfig, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := r.requireCourseProgram(ctx, tx, accountID, programID, true); err != nil {
		return nil, err
	}
	if err := requireProgramConfigVersion(ctx, tx, accountID, programID, expectedUpdatedAt); err != nil {
		return nil, err
	}
	if hasDuplicateUUIDs(courseIDs) {
		return nil, ErrInvalidProgramCourse
	}

	existing := make(map[uuid.UUID]struct{})
	rows, err := tx.Query(ctx, `
		SELECT course_id FROM program_courses
		WHERE account_id = $1 AND program_id = $2
	`, accountID, programID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var courseID uuid.UUID
		if err := rows.Scan(&courseID); err != nil {
			rows.Close()
			return nil, err
		}
		existing[courseID] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	if len(courseIDs) > 0 {
		statuses := make(map[uuid.UUID]string, len(courseIDs))
		rows, err := tx.Query(ctx, `
			SELECT id, status FROM courses
			WHERE account_id = $1 AND id = ANY($2::uuid[])
			FOR SHARE
		`, accountID, courseIDs)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id uuid.UUID
			var status string
			if err := rows.Scan(&id, &status); err != nil {
				rows.Close()
				return nil, err
			}
			statuses[id] = status
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
		for _, courseID := range courseIDs {
			status, found := statuses[courseID]
			if !found {
				return nil, ErrInvalidProgramCourse
			}
			if status != "active" {
				if _, alreadyAssigned := existing[courseID]; !alreadyAssigned {
					return nil, ErrInvalidProgramCourse
				}
			}
		}
	}

	if _, err := tx.Exec(ctx, `
		DELETE FROM program_courses WHERE account_id = $1 AND program_id = $2
	`, accountID, programID); err != nil {
		return nil, err
	}
	if len(courseIDs) > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO program_courses (account_id, program_id, course_id, position)
			SELECT $1::uuid, $2::uuid, ordered.course_id, (ordered.ordinality - 1)::int
			FROM unnest($3::uuid[]) WITH ORDINALITY AS ordered(course_id, ordinality)
		`, accountID, programID, courseIDs); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE programs SET updated_at = NOW() WHERE account_id = $1 AND id = $2
	`, accountID, programID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetAcademicConfig(ctx, accountID, programID)
}

func (r *ProgramRepository) ReplaceProgramInstructors(ctx context.Context, accountID, programID uuid.UUID, contactIDs []uuid.UUID, expectedUpdatedAt time.Time) (*domain.ProgramAcademicConfig, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := r.requireCourseProgram(ctx, tx, accountID, programID, true); err != nil {
		return nil, err
	}
	if err := requireProgramConfigVersion(ctx, tx, accountID, programID, expectedUpdatedAt); err != nil {
		return nil, err
	}
	if hasDuplicateUUIDs(contactIDs) {
		return nil, ErrInvalidInstructor
	}

	if len(contactIDs) > 0 {
		valid := make(map[uuid.UUID]struct{}, len(contactIDs))
		rows, err := tx.Query(ctx, `
			SELECT id FROM contacts
			WHERE account_id = $1 AND id = ANY($2::uuid[]) AND COALESCE(is_group, FALSE) = FALSE
			FOR SHARE
		`, accountID, contactIDs)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			valid[id] = struct{}{}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
		for _, contactID := range contactIDs {
			if _, found := valid[contactID]; !found {
				return nil, ErrInvalidInstructor
			}
		}
	}

	if _, err := tx.Exec(ctx, `
		DELETE FROM program_instructors WHERE account_id = $1 AND program_id = $2
	`, accountID, programID); err != nil {
		return nil, err
	}
	if len(contactIDs) > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO program_instructors (account_id, program_id, contact_id, position)
			SELECT $1::uuid, $2::uuid, ordered.contact_id, (ordered.ordinality - 1)::int
			FROM unnest($3::uuid[]) WITH ORDINALITY AS ordered(contact_id, ordinality)
		`, accountID, programID, contactIDs); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE programs SET updated_at = NOW() WHERE account_id = $1 AND id = $2
	`, accountID, programID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetAcademicConfig(ctx, accountID, programID)
}

type courseProgramQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func requireProgramConfigVersion(ctx context.Context, q courseProgramQuerier, accountID, programID uuid.UUID, expectedUpdatedAt time.Time) error {
	var currentUpdatedAt time.Time
	if err := q.QueryRow(ctx, `
		SELECT updated_at FROM programs WHERE account_id = $1 AND id = $2
	`, accountID, programID).Scan(&currentUpdatedAt); err != nil {
		return err
	}
	if expectedUpdatedAt.IsZero() || !currentUpdatedAt.Equal(expectedUpdatedAt) {
		return ErrAcademicConfigConflict
	}
	return nil
}

func (r *ProgramRepository) requireCourseProgram(ctx context.Context, q courseProgramQuerier, accountID, programID uuid.UUID, lock bool) error {
	query := `SELECT type FROM programs WHERE account_id = $1 AND id = $2`
	if lock {
		query += ` FOR UPDATE`
	}
	var programType string
	if err := q.QueryRow(ctx, query, accountID, programID).Scan(&programType); err != nil {
		if err == pgx.ErrNoRows {
			return ErrProgramNotFound
		}
		return err
	}
	if strings.TrimSpace(programType) != "course" {
		return ErrProgramNotCourse
	}
	return nil
}

func hasDuplicateUUIDs(ids []uuid.UUID) bool {
	seen := make(map[uuid.UUID]struct{}, len(ids))
	for _, id := range ids {
		if id == uuid.Nil {
			return true
		}
		if _, exists := seen[id]; exists {
			return true
		}
		seen[id] = struct{}{}
	}
	return false
}
