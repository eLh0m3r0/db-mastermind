import type { DriverId } from '../types.js'
import { DUCKDB_CATALOG } from './duckdb-catalog.js'
import { POSTGRES_CATALOG } from './postgres-catalog.js'
import { SQLITE_CATALOG } from './sqlite-catalog.js'

export interface SqlFunction {
  name: string
  kind: 'function' | 'aggregate' | 'window'
  /** `(args) → result`, one per overload. */
  signatures: string[]
  doc?: string
}

type Entry = readonly [string, 'f' | 'a' | 'w', readonly string[], string]

const KIND = { f: 'function', a: 'aggregate', w: 'window' } as const

/** Compact hand-written lists: `name(args) → result | description`; a leading `a:` / `w:` marks aggregates / windows. */
function parse(lines: string): Entry[] {
  const map = new Map<string, { kind: 'f' | 'a' | 'w'; sigs: string[]; doc: string }>()
  for (const raw of lines.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = /^(?:([aw]):)?([A-Za-z_][\w$]*)(\(.*?\)(?:\s*→\s*[^|]+)?)?\s*(?:\|\s*(.*))?$/.exec(line)
    if (!m) continue
    const [, k, name, sig, doc] = m
    const e = map.get(name!) ?? { kind: (k as 'a' | 'w' | undefined) ?? 'f', sigs: [], doc: '' }
    if (sig) e.sigs.push(sig.trim())
    if (doc && !e.doc) e.doc = doc.trim()
    map.set(name!, e)
  }
  return [...map].map(([name, e]) => [name, e.kind, e.sigs, e.doc] as const)
}

// Constructs PostgreSQL parses as syntax, so pg_proc doesn't list them.
const POSTGRES_SYNTAX = `
coalesce(value, …) → same type | first argument that is not null
nullif(a, b) → same type | null when a = b, else a
greatest(value, …) → same type | largest of the arguments
least(value, …) → same type | smallest of the arguments
trim([leading | trailing | both] [characters] from text) → text | remove characters from both ends
cast(value AS type) → type | convert to another type
`

const ANSI = `
coalesce(value, …) | first argument that is not null
nullif(a, b) | null when a = b, else a
cast(value AS type) | convert to another type
a:count(*) → integer | number of rows
a:count(expr) → integer | number of non-null values
a:sum(expr) | sum of the values
a:avg(expr) | average of the values
a:min(expr) | smallest value
a:max(expr) | largest value
w:row_number() OVER (…) | number of the row within its partition
w:rank() OVER (…) | rank with gaps
w:dense_rank() OVER (…) | rank without gaps
w:lag(expr [, offset [, default]]) OVER (…) | value from a previous row
w:lead(expr [, offset [, default]]) OVER (…) | value from a following row
w:first_value(expr) OVER (…) | first value of the window frame
w:last_value(expr) OVER (…) | last value of the window frame
w:ntile(n) OVER (…) | bucket number from 1 to n
abs(x) | absolute value
round(x [, digits]) | round to the given number of digits
floor(x) | largest integer not greater than x
ceiling(x) | smallest integer not less than x
power(x, y) | x raised to the power y
sqrt(x) | square root
lower(text) | text in lower case
upper(text) | text in upper case
replace(text, from, to) | replace every occurrence of from
`

const MYSQL = `${ANSI}
ifnull(value, fallback) | fallback when value is null
if(condition, then, else) | then when the condition is true, else otherwise
concat(text, …) | joined text (null if any argument is null)
concat_ws(separator, text, …) | text joined with a separator, nulls skipped
substring(text, start [, length]) | part of the text
substring_index(text, delimiter, count) | text before the count-th delimiter
length(text) | length in bytes
char_length(text) | length in characters
trim(text) | text without surrounding spaces
ltrim(text) | text without leading spaces
rtrim(text) | text without trailing spaces
lpad(text, length, pad) | text padded on the left
rpad(text, length, pad) | text padded on the right
left(text, n) | first n characters
right(text, n) | last n characters
locate(substring, text [, start]) | position of a substring
instr(text, substring) | position of a substring
reverse(text) | text reversed
repeat(text, n) | text repeated n times
format(number, decimals) | number formatted with thousands separators
regexp_like(text, pattern) | whether the text matches a regular expression
regexp_replace(text, pattern, replacement) | replace matches of a regular expression
regexp_substr(text, pattern) | first match of a regular expression
now() | current date and time
curdate() | current date
curtime() | current time
current_timestamp() | current date and time
utc_timestamp() | current UTC date and time
date(expr) | date part of a date/time
date_format(date, format) | date formatted as text
str_to_date(text, format) | text parsed as a date
date_add(date, INTERVAL n unit) | date plus an interval
date_sub(date, INTERVAL n unit) | date minus an interval
datediff(a, b) | days between two dates
timestampdiff(unit, a, b) | difference in the given unit
year(date) | year
month(date) | month
day(date) | day of the month
hour(time) | hour
minute(time) | minute
dayofweek(date) | day of the week (1 = Sunday)
last_day(date) | last day of the month
unix_timestamp([date]) | seconds since 1970-01-01
from_unixtime(seconds) | date/time from a Unix timestamp
extract(unit FROM date) | part of a date/time
rand([seed]) | random number between 0 and 1
mod(n, m) | remainder
truncate(x, digits) | x truncated to the given digits
greatest(value, …) | largest argument
least(value, …) | smallest argument
uuid() | new UUID
md5(text) | MD5 hash
sha2(text, bits) | SHA-2 hash
json_extract(json, path, …) | value at a JSON path
json_unquote(json) | JSON value as text
json_object(key, value, …) | JSON object
json_array(value, …) | JSON array
json_contains(json, candidate [, path]) | whether a JSON document contains another
json_set(json, path, value, …) | JSON with values set
json_length(json [, path]) | number of elements
json_table(json, path COLUMNS (…)) | JSON as rows
a:group_concat(expr [ORDER BY …] [SEPARATOR text]) | values joined into text
a:json_arrayagg(expr) | values as a JSON array
a:json_objectagg(key, value) | pairs as a JSON object
a:std(expr) | population standard deviation
database() | current database
last_insert_id() | last AUTO_INCREMENT value of this session
row_count() | rows changed by the last statement
found_rows() | rows the last SELECT would have returned
version() | server version
connection_id() | id of this connection
sleep(seconds) | wait
`

const MSSQL = `${ANSI}
isnull(value, fallback) | fallback when value is null
iif(condition, then, else) | then when the condition is true, else otherwise
choose(index, value, …) | the index-th value
convert(type, value [, style]) | convert to another type with a style
try_cast(value AS type) | cast, or null when it fails
try_convert(type, value [, style]) | convert, or null when it fails
format(value, format [, culture]) | value formatted as text
concat(text, …) | joined text (nulls as empty)
concat_ws(separator, text, …) | text joined with a separator
len(text) | length without trailing spaces
datalength(expr) | size in bytes
substring(text, start, length) | part of the text
left(text, n) | first n characters
right(text, n) | last n characters
charindex(substring, text [, start]) | position of a substring
patindex(pattern, text) | position of a LIKE pattern
ltrim(text) | text without leading spaces
rtrim(text) | text without trailing spaces
trim(text) | text without surrounding spaces
stuff(text, start, length, insert) | replace part of the text
replicate(text, n) | text repeated n times
reverse(text) | text reversed
string_split(text, separator) | text split into rows
translate(text, from, to) | replace characters
quotename(name) | name in brackets
getdate() | current date and time
getutcdate() | current UTC date and time
sysdatetime() | current date and time (datetime2)
sysdatetimeoffset() | current date and time with offset
dateadd(part, n, date) | date plus n parts
datediff(part, start, end) | number of part boundaries crossed
datediff_big(part, start, end) | datediff as bigint
datepart(part, date) | part of a date as a number
datename(part, date) | part of a date as text
datefromparts(year, month, day) | date from parts
eomonth(date [, months]) | last day of the month
year(date) | year
month(date) | month
day(date) | day of the month
isdate(expr) | whether the text is a valid date
isnumeric(expr) | whether the text is a number
newid() | new uniqueidentifier
newsequentialid() | sequential uniqueidentifier (defaults only)
rand([seed]) | random number between 0 and 1
checksum(expr, …) | hash of the values
hashbytes(algorithm, value) | hash (MD5, SHA2_256, …)
square(x) | x squared
sign(x) | sign of x
json_value(json, path) | scalar at a JSON path
json_query(json, path) | object or array at a JSON path
json_modify(json, path, value) | JSON with a value changed
isjson(text) | whether the text is JSON
openjson(json [, path]) | JSON as rows
object_id(name [, type]) | id of an object
object_name(id) | name of an object
db_name() | current database
schema_name() | default schema
suser_sname() | login name
scope_identity() | last identity value in this scope
error_message() | message of the caught error
error_number() | number of the caught error
a:string_agg(expr, separator) | values joined into text
a:count_big(expr) | count as bigint
a:stdev(expr) | standard deviation
a:var(expr) | variance
w:percent_rank() OVER (…) | relative rank
`

const ORACLE = `${ANSI}
nvl(value, fallback) | fallback when value is null
nvl2(value, if_not_null, if_null) | choose by nullness
decode(expr, search, result, …, default) | compare and return
to_char(value [, format]) | value as text
to_date(text [, format]) | text as a date
to_number(text [, format]) | text as a number
to_timestamp(text [, format]) | text as a timestamp
sysdate | current date and time
systimestamp | current timestamp with time zone
trunc(date | number [, format]) | truncate a date or number
add_months(date, n) | date plus n months
months_between(a, b) | months between dates
last_day(date) | last day of the month
substr(text, start [, length]) | part of the text
instr(text, substring [, start [, occurrence]]) | position of a substring
length(text) | length
trim(text) | text without surrounding spaces
lpad(text, length [, pad]) | padded on the left
rpad(text, length [, pad]) | padded on the right
regexp_like(text, pattern) | whether the text matches
regexp_substr(text, pattern) | match of a regular expression
regexp_replace(text, pattern, replacement) | replace matches
mod(n, m) | remainder
greatest(value, …) | largest argument
least(value, …) | smallest argument
sys_guid() | new GUID
a:listagg(expr, separator) WITHIN GROUP (ORDER BY …) | values joined into text
`

const CLICKHOUSE = `${ANSI}
ifNull(value, fallback) | fallback when value is null
if(condition, then, else) | conditional
multiIf(cond, then, …, else) | several conditions
toString(value) | value as text
toDate(value) | value as a date
toDateTime(value) | value as a date and time
toInt64(value) | value as Int64
toStartOfDay(date) | start of the day
toStartOfMonth(date) | first day of the month
toYYYYMM(date) | year and month as a number
now() | current date and time
today() | current date
dateDiff(unit, a, b) | difference in the given unit
formatDateTime(time, format) | date/time as text
length(value) | length
substring(text, offset, length) | part of the text
concat(text, …) | joined text
splitByChar(separator, text) | text split into an array
arrayJoin(array) | array elements as rows
has(array, value) | whether the array contains the value
JSONExtractString(json, key) | text from JSON
rand() | random UInt32
generateUUIDv4() | new UUID
a:uniq(expr) | approximate distinct count
a:uniqExact(expr) | exact distinct count
a:groupArray(expr) | values as an array
a:any(expr) | any value
a:argMax(arg, val) | arg at the maximum of val
a:quantile(level)(expr) | approximate quantile
`

const BIGQUERY = `${ANSI}
ifnull(value, fallback) | fallback when value is null
if(condition, then, else) | conditional
safe_cast(value AS type) | cast, or null when it fails
concat(text, …) | joined text
format(format, value, …) | formatted text
length(text) | length
substr(text, start [, length]) | part of the text
split(text [, delimiter]) | text split into an array
regexp_contains(text, pattern) | whether the text matches
regexp_extract(text, pattern) | first match
regexp_replace(text, pattern, replacement) | replace matches
current_date() | current date
current_timestamp() | current timestamp
date_trunc(date, part) | date truncated to a part
date_add(date, INTERVAL n part) | date plus an interval
date_diff(a, b, part) | difference in parts
timestamp_trunc(ts, part) | timestamp truncated
format_date(format, date) | date as text
parse_date(format, text) | text as a date
extract(part FROM date) | part of a date
generate_uuid() | new UUID
rand() | random number between 0 and 1
unnest(array) | array elements as rows
array_length(array) | number of elements
json_value(json [, path]) | scalar from JSON
a:array_agg(expr) | values as an array
a:string_agg(expr [, separator]) | values joined into text
a:countif(condition) | rows where the condition is true
a:any_value(expr) | any value
a:approx_count_distinct(expr) | approximate distinct count
`

const TRINO = `${ANSI}
if(condition, then [, else]) | conditional
try(expr) | null instead of an error
try_cast(value AS type) | cast, or null when it fails
concat(text, …) | joined text
length(text) | length
substr(text, start [, length]) | part of the text
split(text, delimiter) | text split into an array
strpos(text, substring) | position of a substring
regexp_like(text, pattern) | whether the text matches
regexp_extract(text, pattern) | first match
regexp_replace(text, pattern [, replacement]) | replace matches
now() | current timestamp
current_date | current date
date_trunc(unit, value) | truncated to a unit
date_add(unit, n, value) | value plus n units
date_diff(unit, a, b) | difference in units
date_format(timestamp, format) | timestamp as text
from_unixtime(seconds) | timestamp from Unix seconds
cardinality(array) | number of elements
contains(array, value) | whether the array contains the value
json_extract_scalar(json, path) | scalar from JSON
random() | random number between 0 and 1
uuid() | new UUID
greatest(value, …) | largest argument
least(value, …) | smallest argument
a:array_agg(expr) | values as an array
a:listagg(expr, separator) WITHIN GROUP (ORDER BY …) | values joined into text
a:approx_distinct(expr) | approximate distinct count
a:count_if(condition) | rows where the condition is true
a:arbitrary(expr) | any value
`

const SQLITE_DOCS: Record<string, string> = {
  random: 'random 64-bit integer',
  randomblob: 'random bytes',
  ifnull: 'fallback when the value is null',
  iif: 'then when the condition is true, else otherwise',
  coalesce: 'first argument that is not null',
  nullif: 'null when a = b, else a',
  date: 'date as YYYY-MM-DD',
  datetime: 'date and time as YYYY-MM-DD HH:MM:SS',
  time: 'time as HH:MM:SS',
  julianday: 'Julian day number',
  unixepoch: 'seconds since 1970-01-01',
  strftime: 'date/time formatted as text',
  timediff: 'difference between two date/times',
  substr: 'part of the text',
  instr: 'position of a substring',
  length: 'length in characters',
  printf: 'formatted text',
  format: 'formatted text',
  typeof: 'storage class of the value',
  group_concat: 'values joined into text',
  string_agg: 'values joined into text',
  total: 'sum as a float (0.0 for no rows)',
  last_insert_rowid: 'rowid of the last inserted row',
  changes: 'rows changed by the last statement',
  json_extract: 'value at a JSON path',
  json_each: 'JSON elements as rows',
  json_object: 'JSON object',
  json_array: 'JSON array',
  json_group_array: 'values as a JSON array',
  json_group_object: 'pairs as a JSON object',
  hex: 'value as hexadecimal text',
  quote: 'value as an SQL literal',
  round: 'round to the given number of digits',
  replace: 'replace every occurrence',
  trim: 'text without surrounding characters',
  lower: 'text in lower case',
  upper: 'text in upper case',
}
// Table-valued functions SQLite builds in but pragma_function_list doesn't report.
const SQLITE_EXTRA = `
json_each(json [, path]) | JSON elements as rows
json_tree(json [, path]) | every JSON element, recursively, as rows
`

function toFunctions(entries: Iterable<Entry>, docs: Record<string, string> = {}): SqlFunction[] {
  const byName = new Map<string, SqlFunction>()
  for (const [name, kind, signatures, doc] of entries) {
    const key = name.toLowerCase()
    const prev = byName.get(key)
    if (prev) {
      for (const s of signatures) if (!prev.signatures.includes(s)) prev.signatures.push(s)
      if (!prev.doc && doc) prev.doc = doc
      continue
    }
    byName.set(key, { name, kind: KIND[kind], signatures: [...signatures], ...(doc || docs[name] ? { doc: doc || docs[name] } : {}) })
  }
  return [...byName.values()]
}

const cache = new Map<DriverId, SqlFunction[]>()

/**
 * Built-in functions of an engine for the editor's completions: PostgreSQL, DuckDB and SQLite from their own
 * catalogs (scripts/sql-functions.mjs), the others from a hand-written list of the common ones.
 */
export function sqlFunctions(driver: DriverId): SqlFunction[] {
  let list = cache.get(driver)
  if (list) return list
  switch (driver) {
    case 'postgres':
      list = toFunctions([...POSTGRES_CATALOG, ...parse(POSTGRES_SYNTAX)])
      break
    case 'duckdb':
      list = toFunctions([...DUCKDB_CATALOG, ...parse(POSTGRES_SYNTAX)])
      break
    case 'sqlite':
      list = toFunctions([...SQLITE_CATALOG, ...parse(SQLITE_EXTRA)], SQLITE_DOCS)
      break
    case 'mysql':
    case 'mariadb':
      list = toFunctions(parse(MYSQL))
      break
    case 'mssql':
      list = toFunctions(parse(MSSQL))
      break
    case 'oracle':
      list = toFunctions(parse(ORACLE))
      break
    case 'clickhouse':
      list = toFunctions(parse(CLICKHOUSE))
      break
    case 'bigquery':
      list = toFunctions(parse(BIGQUERY))
      break
    case 'trino':
      list = toFunctions(parse(TRINO))
      break
    default:
      list = toFunctions(parse(ANSI))
  }
  cache.set(driver, list)
  return list
}
