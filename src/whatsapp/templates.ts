// Message templates, built on the fork's createTemplateManager + renderTemplate.
// Presets (invoice, greeting, support, …) are loaded on init.
import { createTemplateManager, renderTemplate } from "@innovatorssoft/baileys";

let mgr: any = null;

function manager(): any {
  if (!mgr) mgr = createTemplateManager(true); // includePresets = true
  return mgr;
}

export function render(name: string, vars: Record<string, string>): string {
  return manager().render(name, vars);
}

// One-off render without registering a template.
export function quick(template: string, vars: Record<string, string>): string {
  return renderTemplate(template, vars);
}

export function list(): any[] {
  try {
    return manager().getAll?.() ?? [];
  } catch {
    return [];
  }
}

export function create(def: { name: string; content: string; category?: string }): any {
  return manager().create(def);
}
