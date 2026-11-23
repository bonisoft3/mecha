#!lua flags=allow-oom

local stream, expected, limit, mode = KEYS[1], ARGV[1], ARGV[2], ARGV[3]
if not stream or stream == '' then return redis.error_reply('stream is required') end
if not limit or not string.match(limit, '^%d+$') or #limit > 9 or tonumber(limit) < 1 or tonumber(limit) > 10000 then
  return redis.error_reply('invalid trim limit')
end
local trim_limit = tonumber(limit)
if not expected or expected == '' or string.sub(expected, 1, 1) == ',' or string.sub(expected, -1) == ',' or string.find(expected, ',,', 1, true) then
  return redis.error_reply('invalid expected groups')
end
if mode ~= 'plan' and mode ~= 'apply' then return redis.error_reply('invalid mode') end
local required = {}
for group in string.gmatch(expected, '[^,]+') do
  if required[group] then return redis.error_reply('duplicate expected group') end
  required[group] = true
end
local kind = redis.call('TYPE', stream).ok
if kind ~= 'stream' then return redis.error_reply('key is not a stream: ' .. kind) end

local max = '18446744073709551615'
local function normalized(part)
  part = string.gsub(part, '^0+', '')
  return part == '' and '0' or part
end
local function decimal_less(a, b)
  return #a < #b or (#a == #b and a < b)
end
local function parts(id)
  local ms, seq = string.match(id, '^(%d+)%-(%d+)$')
  if not ms then error('invalid stream ID: ' .. tostring(id)) end
  ms, seq = normalized(ms), normalized(seq)
  if decimal_less(max, ms) or decimal_less(max, seq) then error('stream ID out of range') end
  return ms, seq
end
local function less(a, b)
  if not a then return false end
  if not b then return true end
  local am, as = parts(a)
  local bm, bs = parts(b)
  if am ~= bm then return decimal_less(am, bm) end
  return decimal_less(as, bs)
end
local groups = redis.call('XINFO', 'GROUPS', stream)
local before = redis.call('XLEN', stream)
local boundary, inclusive, blocking = nil, false, cjson.null
local found = {}
for _, fields in ipairs(groups) do
  local info = {}
  for i = 1, #fields, 2 do info[fields[i]] = fields[i + 1] end
  local name = info.name
  if not name or not info['last-delivered-id'] then error('invalid group metadata') end
  found[name] = true
  local frontier, group_inclusive = info['last-delivered-id'], true
  parts(frontier)
  local pending = redis.call('XPENDING', stream, name)
  if pending[2] and not less(frontier, pending[2]) then frontier, group_inclusive = pending[2], false end
  if less(frontier, boundary) or (boundary == frontier and not group_inclusive and inclusive) then
    boundary, inclusive, blocking = frontier, group_inclusive, name
  end
end
for group in pairs(required) do
  if not found[group] then return redis.error_reply('missing expected consumer group: ' .. group) end
end
local trimmed = 0
if #groups > 0 and mode == 'apply' then
  trimmed = redis.call('XTRIM', stream, 'MINID', '~', boundary, 'LIMIT', trim_limit)
  if trimmed == 0 then
    local entries = redis.call('XRANGE', stream, '-', inclusive and boundary or '(' .. boundary, 'COUNT', math.min(trim_limit, 128))
    if #entries > 0 then
      local ids = {}
      for _, entry in ipairs(entries) do table.insert(ids, entry[1]) end
      trimmed = redis.call('XDEL', stream, unpack(ids))
    end
  end
end
local after = redis.call('XLEN', stream)
return cjson.encode({before = before, after = after, trimmed = trimmed, boundary = boundary, boundary_inclusive = inclusive, blocking_group = blocking, groups = #groups, mode = mode})
