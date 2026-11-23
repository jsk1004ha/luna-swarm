import type { Department } from "../types.js";
import type { HeadquartersId } from "./contracts.js";

/**
 * The only authority for projecting legacy persisted departments into the
 * Company OS headquarters taxonomy. Unknown values fail closed.
 */
export function departmentToHeadquarters(department: Department): HeadquartersId {
  switch (department) {
    case "executive":
    case "strategy":
      return "command";
    case "research":
      return "research";
    case "engineering":
      return "engineering";
    case "risk":
    case "quality":
      return "quality";
    case "integration":
      return "integration";
    default:
      return assertNeverDepartment(department);
  }
}

/** A stable legacy projection used only by persisted state and the UI. */
export function headquartersToLegacyDepartment(headquartersId: HeadquartersId): Department {
  switch (headquartersId) {
    case "command":
      return "strategy";
    case "research":
      return "research";
    case "engineering":
      return "engineering";
    case "quality":
      return "quality";
    case "integration":
      return "integration";
    default:
      return assertNeverHeadquarters(headquartersId);
  }
}

export function parseLegacyDepartment(value: unknown): Department {
  if (
    value === "executive" ||
    value === "strategy" ||
    value === "research" ||
    value === "engineering" ||
    value === "risk" ||
    value === "quality" ||
    value === "integration"
  ) {
    return value;
  }
  throw new Error(`Unknown legacy Department: ${String(value)}`);
}

function assertNeverDepartment(value: never): never {
  throw new Error(`Unhandled Department: ${String(value)}`);
}

function assertNeverHeadquarters(value: never): never {
  throw new Error(`Unhandled HeadquartersId: ${String(value)}`);
}
