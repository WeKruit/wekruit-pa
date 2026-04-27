import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import type { AgentDef } from "@pa/core-types"
import { afterAssistantTurn, loadPersonalizationContext, type MemoryStackDeps } from "./stacked.js"
import type { Mem0Config } from "./mem0.js"

const fakeDb = null as unknown as Firestore

const fakeMem0Config = (overrides: Partial<Mem0Config> = {}): Mem0Config => ({
  apiKey: "k",
  qdrantUrl: "http://qdrant.local",
  qdrantApiKey: "q",
  ...overrides,
})

const minimalAgent: AgentDef = {
  id: "ag1",
  name: "t",
  systemPrompt: "s",
  provider: "openai",
  model: "m",
  temperature: 0.7,
  memoryMode: "mem0",
  toolPolicy: "none",
  version: "1",
}

test("firestore_only does not call Mem0 search or add", async () => {
  let searchCalls = 0
  let addCalls = 0
  const deps: MemoryStackDeps = {
    getMem0Config: () => fakeMem0Config({ apiKey: "should-not-matter" }),
    mem0Search: async () => {
      searchCalls++
      return []
    },
    mem0Add: async () => {
      addCalls++
    },
  }
  const r = await loadPersonalizationContext(
    fakeDb,
    { userId: "u1", sessionId: "s1", userMessage: "hi", memoryMode: "firestore_only" },
    [],
    deps
  )
  assert.equal(searchCalls, 0)
  assert.equal(addCalls, 0)
  assert.equal(r.mem0Degraded, false)
})

test("mem0 with config runs search; writeback calls add", async () => {
  let searchCalls = 0
  let addCalls = 0
  const deps: MemoryStackDeps = {
    getMem0Config: () => fakeMem0Config(),
    mem0Search: async () => {
      searchCalls++
      return ["line1"]
    },
    mem0Add: async () => {
      addCalls++
    },
  }
  const load = await loadPersonalizationContext(
    fakeDb,
    { userId: "u1", sessionId: "s1", userMessage: "hi", memoryMode: "mem0" },
    [],
    deps
  )
  assert.equal(searchCalls, 1)
  assert.equal(load.mem0SearchResultCount, 1)
  assert.ok((load.memoryBlock || "").includes("line1"))

  const after = await afterAssistantTurn(
    fakeDb,
    minimalAgent,
    {
      userId: "u1",
      sessionId: "s1",
      userText: "hi",
      assistantText: "there",
      memoryMode: "mem0",
    },
    deps
  )
  assert.equal(addCalls, 1)
  assert.equal(after.writebackRan, true)
  assert.equal(after.writebackSkipReason, null)
})

test("mem0 without config returns degraded and does not throw on load", async () => {
  const deps: MemoryStackDeps = {
    getMem0Config: () => null,
    mem0Search: async () => {
      throw new Error("should not run")
    },
    mem0Add: async () => {},
  }
  const r = await loadPersonalizationContext(
    fakeDb,
    { userId: "u1", sessionId: "s1", userMessage: "hi", memoryMode: "mem0" },
    [],
    deps
  )
  assert.equal(r.mem0Degraded, true)
  assert.equal(r.mem0DegradedReason, "no_api_key")
})

test("search failure sets degraded and does not throw", async () => {
  const deps: MemoryStackDeps = {
    getMem0Config: () => fakeMem0Config(),
    mem0Search: async () => {
      throw new Error("network")
    },
    mem0Add: async () => {},
  }
  const r = await loadPersonalizationContext(
    fakeDb,
    { userId: "u1", sessionId: "s1", userMessage: "hi", memoryMode: "both" },
    [],
    deps
  )
  assert.equal(r.mem0Degraded, true)
  assert.equal(r.mem0DegradedReason, "search_failed")
})

test("add failure returns add_failed", async () => {
  const deps: MemoryStackDeps = {
    getMem0Config: () => fakeMem0Config(),
    mem0Search: async () => [],
    mem0Add: async () => {
      throw new Error("add")
    },
  }
  const after = await afterAssistantTurn(
    fakeDb,
    minimalAgent,
    {
      userId: "u1",
      sessionId: "s1",
      userText: "a",
      assistantText: "b",
      memoryMode: "mem0",
    },
    deps
  )
  assert.equal(after.writebackRan, false)
  assert.equal(after.writebackSkipReason, "add_failed")
})

// ----------------------------------------------------------------------------
// Phase 11.3 — partition-key kill switch (PA_MEM0_USE_PARTITION_KEY)
// ----------------------------------------------------------------------------

function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  return fn().finally(() => {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  })
}

test("11.3 kill switch DEFAULT (unset): mem0Search/mem0Add use userId, not mem0UserId", async () => {
  await withEnv("PA_MEM0_USE_PARTITION_KEY", undefined, async () => {
    let searchedWith: string | null = null
    let addedWith: string | null = null
    const deps: MemoryStackDeps = {
      getMem0Config: () => fakeMem0Config(),
      mem0Search: async (_c, _q, uid) => {
        searchedWith = uid
        return []
      },
      mem0Add: async (_c, _msgs, uid) => {
        addedWith = uid
      },
    }
    await loadPersonalizationContext(
      fakeDb,
      {
        userId: "u1",
        mem0UserId: "alt_partition",
        sessionId: "s1",
        userMessage: "hi",
        memoryMode: "mem0",
      },
      [],
      deps
    )
    await afterAssistantTurn(
      fakeDb,
      minimalAgent,
      {
        userId: "u1",
        mem0UserId: "alt_partition",
        sessionId: "s1",
        userText: "u",
        assistantText: "a",
        memoryMode: "mem0",
      },
      deps
    )
    assert.equal(searchedWith, "u1", "kill switch off → search keys on userId")
    assert.equal(addedWith, "u1", "kill switch off → add keys on userId")
  })
})

test("11.3 kill switch =false explicit: still legacy userId path", async () => {
  await withEnv("PA_MEM0_USE_PARTITION_KEY", "false", async () => {
    let searchedWith: string | null = null
    const deps: MemoryStackDeps = {
      getMem0Config: () => fakeMem0Config(),
      mem0Search: async (_c, _q, uid) => {
        searchedWith = uid
        return []
      },
      mem0Add: async () => {},
    }
    await loadPersonalizationContext(
      fakeDb,
      {
        userId: "u1",
        mem0UserId: "alt_partition",
        sessionId: "s1",
        userMessage: "hi",
        memoryMode: "mem0",
      },
      [],
      deps
    )
    assert.equal(searchedWith, "u1")
  })
})

test("11.3 kill switch =true: mem0Search uses resolved partition", async () => {
  await withEnv("PA_MEM0_USE_PARTITION_KEY", "true", async () => {
    let searchedWith: string | null = null
    const deps: MemoryStackDeps = {
      getMem0Config: () => fakeMem0Config(),
      mem0Search: async (_c, _q, uid) => {
        searchedWith = uid
        return []
      },
      mem0Add: async () => {},
    }
    await loadPersonalizationContext(
      fakeDb,
      {
        userId: "u1",
        mem0UserId: "alt_partition",
        sessionId: "s1",
        userMessage: "hi",
        memoryMode: "mem0",
      },
      [],
      deps
    )
    assert.equal(searchedWith, "alt_partition", "kill switch on → search keys on resolved partition")
  })
})

test("11.3 kill switch =true: mem0Add uses resolved partition", async () => {
  await withEnv("PA_MEM0_USE_PARTITION_KEY", "true", async () => {
    let addedWith: string | null = null
    const deps: MemoryStackDeps = {
      getMem0Config: () => fakeMem0Config(),
      mem0Search: async () => [],
      mem0Add: async (_c, _msgs, uid) => {
        addedWith = uid
      },
    }
    await afterAssistantTurn(
      fakeDb,
      minimalAgent,
      {
        userId: "u1",
        mem0UserId: "alt_partition",
        sessionId: "s1",
        userText: "u",
        assistantText: "a",
        memoryMode: "mem0",
      },
      deps
    )
    assert.equal(addedWith, "alt_partition")
  })
})

test("11.3 kill switch =true but mem0UserId missing: still falls back to userId", async () => {
  await withEnv("PA_MEM0_USE_PARTITION_KEY", "true", async () => {
    let searchedWith: string | null = null
    const deps: MemoryStackDeps = {
      getMem0Config: () => fakeMem0Config(),
      mem0Search: async (_c, _q, uid) => {
        searchedWith = uid
        return []
      },
      mem0Add: async () => {},
    }
    await loadPersonalizationContext(
      fakeDb,
      {
        userId: "u1",
        // mem0UserId intentionally omitted
        sessionId: "s1",
        userMessage: "hi",
        memoryMode: "mem0",
      },
      [],
      deps
    )
    assert.equal(searchedWith, "u1")
  })
})

test("11.3 kill switch =true but mem0UserId is empty/whitespace: falls back to userId", async () => {
  await withEnv("PA_MEM0_USE_PARTITION_KEY", "true", async () => {
    let searchedWith: string | null = null
    const deps: MemoryStackDeps = {
      getMem0Config: () => fakeMem0Config(),
      mem0Search: async (_c, _q, uid) => {
        searchedWith = uid
        return []
      },
      mem0Add: async () => {},
    }
    await loadPersonalizationContext(
      fakeDb,
      {
        userId: "u1",
        mem0UserId: "   ",
        sessionId: "s1",
        userMessage: "hi",
        memoryMode: "mem0",
      },
      [],
      deps
    )
    assert.equal(searchedWith, "u1")
  })
})

test("11.3 kill switch =true with mem0UserId === userId: no drift, no extra writes", async () => {
  await withEnv("PA_MEM0_USE_PARTITION_KEY", "true", async () => {
    let searchedWith: string | null = null
    const deps: MemoryStackDeps = {
      getMem0Config: () => fakeMem0Config(),
      mem0Search: async (_c, _q, uid) => {
        searchedWith = uid
        return []
      },
      mem0Add: async () => {},
    }
    await loadPersonalizationContext(
      fakeDb,
      {
        userId: "u1",
        mem0UserId: "u1",
        sessionId: "s1",
        userMessage: "hi",
        memoryMode: "mem0",
      },
      [],
      deps
    )
    assert.equal(searchedWith, "u1")
  })
})
