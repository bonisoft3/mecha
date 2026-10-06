defmodule Mecha.SnapshotWaiterRegression do
  alias Electric.Shapes.Consumer
  alias Consumer.State

  defmodule Storage do
    def supports_txn_fragment_streaming?, do: true
    def fetch_latest_offset(_), do: {:ok, Electric.Replication.LogOffset.last_before_real_offsets()}
    def fetch_pg_snapshot(snapshot), do: {:ok, snapshot}
    def mark_snapshot_as_started(_), do: :ok
  end

  def run do
    stack = "mecha-snapshot-waiter-regression"
    metadata = :ets.new(:"shape_meta_table:#{stack}", [:named_table, :public])

    try do
      for snapshot <- [nil, %{xmin: 10, xmax: 20, xip_list: [15], filter_txns?: false}] do
        handle = if snapshot == nil, do: "fresh", else: "restored"
        :ets.insert(metadata, {handle, 0, false, nil, 0})
        state = %State{stack_id: stack, shape_handle: handle}
        refs = [make_ref(), make_ref()]

        waiting = Enum.reduce(refs, state, fn ref, state ->
          {:noreply, state, _} = Consumer.handle_call(:await_snapshot_start, {self(), ref}, state)
          state
        end)

        initialized = State.initialize(waiting, {Storage, snapshot}, nil)
        expected_snapshot = if snapshot == nil, do: nil, else: {10, 20, [15]}
        ^expected_snapshot = initialized.initial_snapshot_state.pg_snapshot
        expected_buffering = snapshot == nil
        ^expected_buffering = initialized.buffering?
        ^expected_buffering = initialized.initial_snapshot_state.filtering?

        late = make_ref()
        {:noreply, initialized, _} = Consumer.handle_call(:await_snapshot_start, {self(), late}, initialized)
        {:noreply, started, _} = Consumer.handle_cast({:snapshot_started, handle}, initialized)

        for ref <- refs ++ [late] do
          receive do
            {^ref, :started} -> :ok
          after
            0 -> raise "#{handle}: initialization discarded a waiting snapshot caller"
          end
        end

        [] = started.initial_snapshot_state.awaiting_snapshot_start
        true = Electric.ShapeCache.ShapeStatus.snapshot_started?(stack, handle)
        {:reply, :started, _, _} = Consumer.handle_call(:await_snapshot_start, {self(), make_ref()}, started)
        {:noreply, _, _} = Consumer.handle_cast({:snapshot_started, handle}, started)

        receive do
          {_ref, :started} -> raise "#{handle}: snapshot caller replied twice"
        after
          0 -> :ok
        end
      end
    after
      :ets.delete(metadata)
    end

    IO.puts("Electric snapshot waiters survive fresh and restored initialization")
  end
end

if System.get_env("MECHA_ELECTRIC_TEST_ONLY") == "1" do
  Mecha.SnapshotWaiterRegression.run()
else
  "1.8.1" = Application.spec(:electric, :vsn) |> List.to_string()
  source_url = "https://raw.githubusercontent.com/electric-sql/electric/0f404200402f918a4b1596bc5c8a53479a435349/packages/sync-service/lib/electric/shapes/consumer/state.ex"
  checksum = "e94be3ef70ebcca4e072db4ba537dddcd77a1af5b9137e24c92651076f8862cb"

  source = case System.cmd("curl", ["--fail", "--silent", "--show-error", "--location", source_url], stderr_to_stdout: true) do
    {source, 0} -> source
    {error, status} -> raise "Electric source fetch failed (#{status}): #{error}"
  end

  ^checksum = :crypto.hash(:sha256, source) |> Base.encode16(case: :lower)
  before = "    initial_snapshot_state = InitialSnapshot.new(pg_snapshot)"
  replacement = """
      initial_snapshot_state = %{
        InitialSnapshot.new(pg_snapshot)
        | awaiting_snapshot_start: state.initial_snapshot_state.awaiting_snapshot_start
      }
  """ |> String.trim_trailing()
  [prefix, suffix] = String.split(source, before)

  module = Electric.Shapes.Consumer.State
  Code.ensure_loaded!(module)
  beam_path = :code.which(module)
  Code.compiler_options(ignore_module_conflict: true)
  [{^module, beam}] = Code.compile_string(prefix <> replacement <> suffix, "lib/electric/shapes/consumer/state.ex")
  Mecha.SnapshotWaiterRegression.run()
  File.write!(beam_path, beam)
end
