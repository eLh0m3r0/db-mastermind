import { describe, expect, it } from 'vitest'
import { mysqlDefaultSql } from '../src/drivers/mysql.js'

describe('MySQL column defaults as SQL', () => {
  it('quotes the literals MySQL reports bare and leaves numbers, expressions and MariaDB alone', () => {
    expect(mysqlDefaultSql('pending', '', false)).toBe("'pending'")
    expect(mysqlDefaultSql('', '', false)).toBe("''")
    expect(mysqlDefaultSql("it's", '', false)).toBe("'it''s'")
    expect(mysqlDefaultSql('0', '', false)).toBe('0')
    expect(mysqlDefaultSql('-1.50', '', false)).toBe('-1.50')
    expect(mysqlDefaultSql("b'1'", '', false)).toBe("b'1'")
    expect(mysqlDefaultSql('CURRENT_TIMESTAMP', 'DEFAULT_GENERATED', false)).toBe('CURRENT_TIMESTAMP')
    expect(mysqlDefaultSql('CURRENT_TIMESTAMP(3)', 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3)', false)).toBe('CURRENT_TIMESTAMP(3)')
    // MySQL 5.7 has no DEFAULT_GENERATED mark.
    expect(mysqlDefaultSql('CURRENT_TIMESTAMP', '', false)).toBe('CURRENT_TIMESTAMP')
    expect(mysqlDefaultSql('uuid()', 'DEFAULT_GENERATED', false)).toBe('(uuid())')
    expect(mysqlDefaultSql("'pending'", '', true)).toBe("'pending'")
    expect(mysqlDefaultSql('uuid()', '', true)).toBe('uuid()')
  })
})
