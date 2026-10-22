import { describe, expect, it } from 'vitest'
import { parseDbml, tablesFromPrisma, toDbml } from '../src/index.js'

const schema = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  USER
  ADMIN
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique @db.VarChar(200)
  name      String?
  role      Role     @default(USER)
  createdAt DateTime @default(now()) @map("created_at")
  posts     Post[]
  profile   Profile?

  @@map("users")
}

model Post {
  id        String   @id @default(uuid())
  title     String
  published Boolean  @default(false)
  author    User     @relation(fields: [authorId], references: [id], onDelete: Cascade)
  authorId  Int      @map("author_id")
  tags      String[]

  @@index([authorId, published])
}

model Profile {
  userId Int    @unique
  bio    String
  user   User   @relation(fields: [userId], references: [id])
}

model Membership {
  userId  Int
  groupId Int
  @@id([userId, groupId])
}
`

describe('tablesFromPrisma', () => {
  const { tables, enums, errors } = tablesFromPrisma(schema)
  const t = (name: string) => tables.find((x) => x.name === name)!

  it('maps models, columns and types', () => {
    expect(tables.map((x) => x.name)).toEqual(['users', 'Post', 'Profile', 'Membership'])
    expect(enums).toEqual({ Role: ['USER', 'ADMIN'] })
    expect(t('users').columns.map((c) => [c.name, c.dataType, c.nullable, c.defaultValue ?? null, c.isIdentity])).toEqual([
      ['id', 'integer', false, null, true],
      ['email', 'varchar(200)', false, null, false],
      ['name', 'text', true, null, false],
      ['role', 'Role', false, "'USER'", false],
      ['created_at', 'timestamp(3)', false, 'now()', false],
    ])
    expect(t('users').primaryKey).toEqual(['id'])
    expect(t('users').indexes).toMatchObject([{ columns: ['email'], unique: true }])
    expect(errors).toEqual([{ line: 0, message: 'Post.tags: scalar lists (String[]) are kept as text' }])
  })

  it('maps relations, composite keys and indexes with database names', () => {
    expect(t('Post').foreignKeys).toEqual([{ name: 'Post_author_id_fkey', columns: ['author_id'], refTable: 'users', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: undefined }])
    expect(t('Post').indexes).toMatchObject([{ columns: ['author_id', 'published'], unique: false }])
    expect(t('Post').columns.find((c) => c.name === 'id')!.defaultValue).toBeNull()
    expect(t('Membership').primaryKey).toEqual(['userId', 'groupId'])
    expect(t('Profile').foreignKeys[0]).toMatchObject({ columns: ['userId'], refTable: 'users' })
  })

  it('round-trips through DBML', () => {
    const dbml = toDbml(tables, { enums })
    const back = parseDbml(dbml)
    expect(back.errors).toEqual([])
    expect(back.tables.map((x) => x.name).sort()).toEqual(['Membership', 'Post', 'Profile', 'users'])
    expect(back.tables.find((x) => x.name === 'Post')!.foreignKeys[0]).toMatchObject({ refTable: 'users', onDelete: 'CASCADE' })
  })
})
