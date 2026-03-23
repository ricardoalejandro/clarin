import re

# 1. Frontend Layout
layout_file = '/root/proyect/clarin/frontend/src/app/dashboard/layout.tsx'
with open(layout_file, 'r') as f:
    text = f.read()

text = text.replace("import { MessageSquare, Users, Home, Settings as SettingsIcon, LogOut, CheckSquare, Sparkles, Smartphone, Menu, Tags as TagsIcon, Presentation, CalendarDays, Key, Bot, Rss, Layers, Link2 } from 'lucide-react';", "import { MessageSquare, Users, Home, Settings as SettingsIcon, LogOut, CheckSquare, Smartphone, Menu, Tags as TagsIcon, Presentation, CalendarDays, Key, Bot, Rss, Layers, Link2 } from 'lucide-react';")
text = text.replace("  '/dashboard/dynamics': 'dynamics',\n", "")
text = text.replace("  { href: '/dashboard/dynamics', icon: Sparkles, label: 'Dinámicas' },\n", "")

with open(layout_file, 'w') as f:
    f.write(text)

# 2. Backend Entities
entities_file = '/root/proyect/clarin/backend/internal/domain/entities.go'
with open(entities_file, 'r') as f:
    text = f.read()

text = text.replace('PermDynamics    = "dynamics"\n\t', "")
text = text.replace('PermDynamics,\n\t', "")

dyn_structs_pattern = r'type DynamicConfig .*?// DynamicItem represent.*?\}$'
text = re.sub(dyn_structs_pattern, '', text, flags=re.DOTALL)

dyn_structs_exact = """// DynamicConfig represents dynamic-specific configuration (like thresholds, colors, etc)
type DynamicConfig map[string]interface{}

// Dynamic represents an interactive app/game instance
type Dynamic struct {
ID          string        `json:"id"`
AccountID   string        `json:"account_id"`
Type        string        `json:"type"` // e.g., "scratch_card"
Name        string        `json:"name"`
Slug        string        `json:"slug"`
Description string        `json:"description"`
Config      DynamicConfig `json:"config"`
IsActive    bool          `json:"is_active"`
CreatedAt   time.Time     `json:"created_at"`
UpdatedAt   time.Time     `json:"updated_at"`
ItemCount   int           `json:"item_count"` // Computed field
}

// DynamicItem represents a single item/content within a dynamic
type DynamicItem struct {
ID        string    `json:"id"`
DynamicID string    `json:"dynamic_id"`
Content   string    `json:"content"`
Author    string    `json:"author"`
ImageURL  string    `json:"image_url"`
SortOrder int       `json:"sort_order"`
IsActive  bool      `json:"is_active"`
CreatedAt time.Time `json:"created_at"`
}"""
text = text.replace(dyn_structs_exact, "")

with open(entities_file, 'w') as f:
    f.write(text)

# 3. Backend Database
database_file = '/root/proyect/clarin/backend/pkg/database/database.go'
with open(database_file, 'r') as f:
    text = f.read()

db_migrations = """_, err = db.Exec(context.Background(), `
CREATE TABLE IF NOT EXISTS dynamics (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
type TEXT NOT NULL,
name TEXT NOT NULL,
slug TEXT NOT NULL,
description TEXT NOT NULL DEFAULT '',
config JSONB NOT NULL DEFAULT '{}'::jsonb,
is_active BOOLEAN NOT NULL DEFAULT true,
created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
UNIQUE (account_id, slug)
)
`)
if err != nil {
log.Fatal("Failed to create dynamics table: ", err)
}

_, err = db.Exec(context.Background(), `
CREATE TABLE IF NOT EXISTS dynamic_items (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
dynamic_id UUID NOT NULL REFERENCES dynamics(id) ON DELETE CASCADE,
content TEXT NOT NULL,
author TEXT NOT NULL DEFAULT '',
image_url TEXT NOT NULL DEFAULT '',
sort_order INTEGER NOT NULL DEFAULT 0,
is_active BOOLEAN NOT NULL DEFAULT true,
created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
)
`)
if err != nil {
log.Fatal("Failed to create dynamic_items table: ", err)
}

// Create indexes for dynamic performance
db.Exec(context.Background(), `CREATE INDEX IF NOT EXISTS idx_dynamics_account_id ON dynamics(account_id)`)
db.Exec(context.Background(), `CREATE INDEX IF NOT EXISTS idx_dynamics_slug ON dynamics(slug)`)
db.Exec(context.Background(), `CREATE INDEX IF NOT EXISTS idx_dynamic_items_dynamic_id ON dynamic_items(dynamic_id)`)
db.Exec(context.Background(), `CREATE INDEX IF NOT EXISTS idx_dynamic_items_sort_order ON dynamic_items(sort_order)`)

"""
text = text.replace(db_migrations, "")
with open(database_file, 'w') as f:
    f.write(text)

# 4. Backend Repository
repo_file = '/root/proyect/clarin/backend/internal/repository/repository.go'
with open(repo_file, 'r') as f:
    text = f.read()

text = text.replace("Dynamic    *DynamicRepository\n", "")
text = text.replace("Dynamic:    &DynamicRepository{db: db},\n", "")
with open(repo_file, 'w') as f:
    f.write(text)

# 5. Backend Server
server_file = '/root/proyect/clarin/backend/internal/api/server.go'
with open(server_file, 'r') as f:
    text = f.read()

server_routes = """// Public Dynamics
api.Get("/public/dynamics/:slug", s.handleGetPublicDynamic)

"""
text = text.replace(server_routes, "")

server_dyn = """// Dynamics
dynamics := protected.Group("/dynamics", s.requirePermission(domain.PermDynamics))
dynamics.Get("/", s.handleListDynamics)
dynamics.Post("/", s.handleCreateDynamic)
dynamics.Get("/check-slug", s.handleCheckDynamicSlug)
dynamics.Get("/:id", s.handleGetDynamic)
dynamics.Put("/:id", s.handleUpdateDynamic)
dynamics.Delete("/:id", s.handleDeleteDynamic)
dynamics.Patch("/:id/active", s.handleToggleDynamicActive)

dynamics.Get("/:id/items", s.handleListDynamicItems)
dynamics.Post("/:id/items", s.handleCreateDynamicItem)
dynamics.Put("/:id/items/reorder", s.handleReorderDynamicItems)
dynamics.Put("/:id/items/:itemId", s.handleUpdateDynamicItem)
dynamics.Delete("/:id/items/:itemId", s.handleDeleteDynamicItem)

"""
text = text.replace(server_dyn, "")
with open(server_file, 'w') as f:
    f.write(text)

print("Done reverting.")
