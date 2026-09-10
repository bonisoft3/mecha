//go:build js && wasm

package main

import (
	"encoding/json"
	"syscall/js"

	"github.com/redpanda-data/benthos/v4/public/bloblang"
	_ "github.com/redpanda-data/benthos/v4/public/components/pure"
)

var env *bloblang.Environment

func init() {
	env = bloblang.NewEnvironment()
}

func blobl(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return "ERROR: blobl requires 2 arguments: mapping string, input JSON string"
	}

	mappingStr := args[0].String()
	inputJSON := args[1].String()

	exec, err := env.Parse(mappingStr)
	if err != nil {
		return "ERROR: parse: " + err.Error()
	}

	var input any
	if err := json.Unmarshal([]byte(inputJSON), &input); err != nil {
		return "ERROR: input: " + err.Error()
	}

	result, err := exec.Query(input)
	if err != nil {
		return "ERROR: exec: " + err.Error()
	}

	out, err := json.Marshal(result)
	if err != nil {
		return "ERROR: marshal: " + err.Error()
	}

	return string(out)
}

func main() {
	js.Global().Set("blobl", js.FuncOf(blobl))
	select {}
}
