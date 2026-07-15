import { describe, expect, it } from "vitest";
import { sha256 } from "../src/context/context-serialization.js";
describe("condition context preparation",()=>{it("hashes exact rendered bytes",()=>expect(sha256("context")).toMatch(/^[0-9a-f]{64}$/));});
