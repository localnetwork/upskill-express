# Conversational Course Assistant — Specification

## Goal

Build an AI chatbot that acts as a **course marketplace and learning assistant**. It should understand natural language, remember conversation context, use real database data, and perform actions for the logged-in user.

## Core Features

- **Search courses**
  - By title, keyword, topic, category, technology, level, price, etc.
  - Example: "Show me web development courses."

- **Search instructors/authors**
  - Example: "Show me courses by John Smith."
  - Provide instructor bio, expertise, courses, and learner information.

- **Course information**
  - Details, curriculum, price, rating, instructor, requirements, etc.

- **Cart management**
  - Add, remove, view, and check cart status.
  - Example: "Add The Complete Web Development Bootcamp to my cart."
  - Support conversational references:
    - "Add this course."
    - "Add the first one."
    - "Remove that course."

- **Enrollment**
  - Check whether the user is enrolled.
  - Show enrolled courses and progress.
  - If already enrolled, handle it according to the platform's business rule. The AI should **not fail simply because the course is enrolled**.

- **Recommendations**
  - Recommend courses using:
    - Enrollments
    - Completed courses
    - Progress
    - Recently viewed courses
    - Search activity
    - Cart activity
    - Categories/interests
  - Explain why each course is recommended.

- **More capabilities**
  - Similar courses
  - Course comparison
  - Learning paths
  - "What should I learn next?"
  - "Continue my course."
  - "Show courses under ₱500."
  - "What courses are in my cart?"

## Conversation Context

The assistant must remember entities from the current conversation.

Example:

> Show me web development courses.

→ AI displays courses.

> Add the first one to my cart.

→ AI identifies the first course's `course_id` and adds it.

> Tell me about the instructor.

→ AI uses the same course/instructor context.

**Do not ask the user to repeat the course title when it is already known from the conversation.**

## Database / Chat History

Store:

```text
chat_conversations
- id
- user_id
- title
- created_at
- updated_at

chat_messages
- id
- conversation_id
- user_id
- role
- content
- metadata
- created_at
```

Conversation state should also retain things like:

```text
current_course_id
current_category_id
current_instructor_id
recent_course_results
```

## AI Tools

The AI should use backend tools such as:

```text
search_courses()
search_categories()
search_instructors()
get_course()
get_instructor()

get_cart()
add_to_cart()
remove_from_cart()

get_enrollments()
check_enrollment()

get_user_activity()
recommend_courses()
get_similar_courses()
```

**Important:** The AI must never invent course data, cart status, enrollment status, prices, or recommendations. The database/backend is the source of truth.

## Critical Fix

This:

> add this course to my cart

should resolve:

```text
"this course"
      ↓
last/current course in conversation
      ↓
course_id
      ↓
check cart/enrollment
      ↓
add_to_cart(course_id)
      ↓
confirm result
```

And:

> add The Complete Web Development Bootcamp: Build Modern Websites to my cart

should automatically search for the course and add it — **no unnecessary clarification request**.
