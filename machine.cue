package cluster

// A machine Mecha runs, as XState v5 writes one: `config` is the machine's
// JSON configuration, exactly the shape `createMachine` takes, and `setup` is
// what XState's `setup()` supplies beside it — the types, and the guards and
// actions the configuration names by string. A name the setup does not
// implement is a function of the same name in the machine's Jessie rules.
#Machine: {
	config: #XState
	setup:  #MachineSetup
}

// The JSON subset of XState v5's machine configuration Mecha executes: flat
// states, transitions on events and `always`, final states, and an `invoke`
// whose `src` names an actor the setup implements. A guard and an action are
// names, as XState's JSON form references them; `meta`, `tags` and
// `description` are XState's own and carry anything else.
#XState: {
	id:           =~"^[a-z][a-z0-9_]{0,30}$"
	initial:      string
	description?: string
	meta?:        {...}
	invoke?:      #XStateInvoke | [...#XStateInvoke]
	// Taken in every state, as XState lets an event a state leaves unhandled
	// reach the machine. A state does not take the same event: XState would
	// fall back to the machine's transition when the state's guard refuses,
	// and one event names one transition here.
	on?: [string]:    #XStateTransitions
	states: [string]: #XStateState
}

#XStateState: close({
	type?:        "final" | "parallel"
	initial?:     string
	description?: string
	tags?:        [...string]
	meta?:        {...}
	on?: [string]: #XStateTransitions
	always?: #XStateTransitions
	invoke?: #XStateInvoke | [...#XStateInvoke]
	states?: [string]: #XStateState
})

#XStateInvoke: close({
	id?:      string
	src:      string
	input?:   {...}
	onDone?:  #XStateTransitions
	onError?: #XStateTransitions
})

// A transition's guard is one name or several, tried in order: XState's
// `and([...])`, which its JSON form has no spelling for.
#XStateTransition: close({
	reenter?:     bool
	target?:      string
	guard?:       string | [string, ...string]
	actions?:     string | [...string]
	description?: string
})

#XStateTransitions: string | #XStateTransition | [...#XStateTransition]

// A value's shape, checked at every step: what XState's `types` states for
// context, input and events, as data the database and the browser both check.
#Shape: {
	let S = self
	type: "string" | "integer" | "boolean" | "array" | "object"
	if S.type == "string" {
		close({
			type:      "string"
			maxLength: int & >=0 & <=65536
			values?:   [...string]
		})
	}
	if S.type == "integer" {
		close({
			type: "integer"
			min:  int & >=-9007199254740991
			max:  int & <=9007199254740991 & >=S.min
		})
	}
	if S.type == "boolean" {
		close({
			type: "boolean"
		})
	}
	if S.type == "array" {
		close({
			type:     "array"
			maxItems: int & >=0 & <=1024
			items:    #Shape
		})
	}
	if S.type == "object" {
		close({
			type: "object"
			fields: [string]: #Shape
		})
	}
}

// The event fields a rule reads beside the context it steps: the payload's
// own, and the three the runtime states on the event, each under the
// underscore SCXML reserves for the platform: who sent it (`_origin`), the
// step's `_time` and its `_entropy`. The event's type is every rule's.
#Reads: [...=~"^[a-z_][a-z0-9_]*$"]

// What a database guard names its refusal.
#Reason: =~"^[a-z][a-z0-9_]{0,63}$"

#MachineSetup: {
	types: {
		// The machine's context; its state value is the configuration's own.
		context: #Shape & {type: "object"}
		// What creates an instance, and `initialize` the rule that turns it into the first context.
		input?: #Shape & {type: "object"}
		// Each event's payload, and which side may send it: a reader, or the machine's own tier.
		events: [string]: {tier: "omnishell" | "mecha", payload: #Shape & {type: "object"}}
		// What each seat reads of the context, and what anyone reads.
		view:    #Shape & {type: "object"}
		public?: #Shape & {type: "object"}
	}
	initialize?: string
	// Each guard and action the configuration names. One the rules implement
	// states its contract: the event fields it reads beside the context, and,
	// for an action, the context fields it writes. The runtime hands it only
	// those inputs and refuses a write outside them. A guard answers a
	// boolean, as XState's does, and its `reason` is what a refusal by it is
	// called. A guard implemented in the database is a precondition over the
	// declared locks, naming the rules' guards it runs after, if any; an
	// action implemented there is a list of relational effects run with the
	// step. A database guard may instead list checks, tried in order, the
	// first not true refusing the event with its own reason.
	guards: [string]:  *close({reads: #Reads, reason?: #Reason}) | close({rules?: [...string], sql: string, reason: #Reason}) | close({rules?: [...string], checks: [_, ...] & [...close({sql: string, reason: #Reason})]})
	actions: [string]: close({reads: #Reads, writes: [...string]}) | [...{...}]
	version: int & >0
	fuel:    *10000 | (int & >0 & <=1000000)
	entropy: *0 | (int & >=0 & <=1024)
	locks?:  [...{...}]
	ports?:  {...}
}
