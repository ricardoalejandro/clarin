export type CourseStatus = 'active' | 'archived'

export interface CourseTopic {
  id: string
  account_id: string
  course_id: string
  title: string
  description: string | null
  status: CourseStatus
  position: number
  usage_count: number
  created_at: string
  updated_at: string
}

export interface Course {
  id: string
  account_id: string
  name: string
  description: string | null
  status: CourseStatus
  position: number
  usage_count: number
  topic_count: number
  active_topic_count: number
  topic_preview: string[]
  created_at: string
  updated_at: string
  topics: CourseTopic[]
}

export interface CourseTopicInput {
  id?: string
  title: string
  description?: string | null
  status?: CourseStatus
}

export interface CourseInput {
  name: string
  description?: string | null
  status?: CourseStatus
  expected_updated_at?: string
  topics: CourseTopicInput[]
}

export interface CourseListResponse {
  courses: Course[]
  total: number
  page: number
  page_size: number
}

export interface CourseResponse {
  course: Course
}

export interface DeleteCourseResponse {
  deleted: boolean
  archived: boolean
  course?: Course
}
