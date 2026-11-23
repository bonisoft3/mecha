#!lua flags=allow-oom

local stream = KEYS[1]
local expected = ARGV[1]
local snapshot = ARGV[2]
if not stream or stream == '' then return redis.error_reply('stream is required') end

local function names(value, required)
  if not value or (required and value == '') then return nil end
  if value ~= '' and (string.sub(value, 1, 1) == ',' or string.sub(value, -1) == ',' or string.find(value, ',,', 1, true)) then return nil end
  local result, order = {}, {}
  for name in string.gmatch(value, '[^,]+') do
    if result[name] then return nil end
    result[name] = true
    table.insert(order, name)
  end
  return result, order
end
local required, order = names(expected, true)
local allowed = names(snapshot, false)
if not required then return redis.error_reply('invalid expected groups') end
if not allowed then return redis.error_reply('invalid snapshot groups') end
for name in pairs(allowed) do
  if not required[name] then return redis.error_reply('snapshot group is not expected: ' .. name) end
end

local kind = redis.call('TYPE', stream).ok
if kind ~= 'none' and kind ~= 'stream' then return redis.error_reply('key is not a stream: ' .. kind) end
local found = {}
local truncated = false
if kind == 'stream' then
  local info = redis.call('XINFO', 'STREAM', stream)
  local fields = {}
  for i = 1, #info, 2 do fields[info[i]] = info[i + 1] end
  if not fields['entries-added'] or not fields.length then error('invalid stream metadata') end
  -- Values above the exact integer range cannot prove that no entry was removed.
  truncated = fields['entries-added'] >= 9007199254740992 or fields['entries-added'] > fields.length
  for _, group in ipairs(redis.call('XINFO', 'GROUPS', stream)) do
    for i = 1, #group, 2 do
      if group[i] == 'name' then found[group[i + 1]] = true end
    end
  end
end
for _, name in ipairs(order) do
  if not found[name] and truncated and not allowed[name] then
    return redis.error_reply('cannot register group on truncated stream: ' .. name)
  end
end
local created = {}
for _, name in ipairs(order) do
  if not found[name] then
    redis.call('XGROUP', 'CREATE', stream, name, '0', 'MKSTREAM')
    table.insert(created, name)
  end
end
return cjson.encode({created = created, truncated = truncated})
