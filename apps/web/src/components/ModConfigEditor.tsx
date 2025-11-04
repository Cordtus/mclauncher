import { useState, useEffect } from "react";
import { Save, RotateCcw, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { ConfigFieldRenderer } from "./ConfigFieldRenderer";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface ConfigField {
  key: string;
  type: 'boolean' | 'number' | 'string' | 'array' | 'object';
  value: any;
  description?: string;
  constraints?: {
    min?: number;
    max?: number;
    options?: any[];
    pattern?: string;
  };
}

interface ConfigSection {
  name: string;
  description?: string;
  fields: ConfigField[];
  subsections?: ConfigSection[];
}

interface ParsedConfig {
  format: string;
  raw: string;
  sections: ConfigSection[];
}

interface ModConfigEditorProps {
  serverName: string;
  modId: string;
  configFileName: string;
  onClose: () => void;
  onSave: () => void;
}

export function ModConfigEditor({
  serverName,
  modId,
  configFileName,
  onClose,
  onSave,
}: ModConfigEditorProps) {
  const [config, setConfig] = useState<ParsedConfig | null>(null);
  const [values, setValues] = useState<Record<string, any>>({});
  const [originalValues, setOriginalValues] = useState<Record<string, any>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});

  useEffect(() => {
    loadConfig();
  }, [serverName, modId, configFileName]);

  async function loadConfig() {
    setIsLoading(true);
    setMessage("");
    try {
      const response = await fetch(`/api/servers/${serverName}/mods/${modId}/config/${configFileName}`);
      if (!response.ok) {
        throw new Error("Failed to load config");
      }

      const data: ParsedConfig = await response.json();
      setConfig(data);

      // Extract all field values
      const fieldValues: Record<string, any> = {};
      data.sections.forEach((section) => {
        extractFieldValues(section, fieldValues);
      });

      setValues(fieldValues);
      setOriginalValues(JSON.parse(JSON.stringify(fieldValues)));

      // Open all sections by default
      const sectionsState: Record<string, boolean> = {};
      data.sections.forEach((section) => {
        sectionsState[section.name] = true;
        if (section.subsections) {
          section.subsections.forEach((sub) => {
            sectionsState[`${section.name}.${sub.name}`] = true;
          });
        }
      });
      setOpenSections(sectionsState);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  function extractFieldValues(section: ConfigSection, target: Record<string, any>) {
    section.fields.forEach((field) => {
      target[field.key] = field.value;
    });
    if (section.subsections) {
      section.subsections.forEach((sub) => extractFieldValues(sub, target));
    }
  }

  function handleFieldChange(key: string, value: any) {
    setValues((prev) => ({
      ...prev,
      [key]: value,
    }));
  }

  async function handleSave() {
    setIsSaving(true);
    setMessage("");
    try {
      // Only send changed values
      const updates: Record<string, any> = {};
      for (const key in values) {
        if (values[key] !== originalValues[key]) {
          updates[key] = values[key];
        }
      }

      if (Object.keys(updates).length === 0) {
        setMessage("No changes to save");
        return;
      }

      const response = await fetch(
        `/api/servers/${serverName}/mods/${modId}/config/${configFileName}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('ADMIN_TOKEN')}`,
          },
          body: JSON.stringify({ updates }),
        }
      );

      if (!response.ok) {
        throw new Error("Failed to save config");
      }

      setMessage("Config saved successfully. Restart server to apply changes.");
      setOriginalValues(JSON.parse(JSON.stringify(values)));
      onSave();
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  }

  function handleRevert() {
    setValues(JSON.parse(JSON.stringify(originalValues)));
    setMessage("Changes reverted");
  }

  function hasChanges(): boolean {
    return JSON.stringify(values) !== JSON.stringify(originalValues);
  }

  function renderSection(section: ConfigSection, parentKey = "") {
    const sectionKey = parentKey ? `${parentKey}.${section.name}` : section.name;
    const isOpen = openSections[sectionKey];

    return (
      <Collapsible
        key={sectionKey}
        open={isOpen}
        onOpenChange={(open) => setOpenSections({ ...openSections, [sectionKey]: open })}
      >
        <Card className="rounded-sm">
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">{section.name}</CardTitle>
                  {section.description && (
                    <CardDescription className="text-xs mt-1">{section.description}</CardDescription>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {section.fields.length > 0 && (
                    <Badge variant="secondary" className="text-xs">
                      {section.fields.length} {section.fields.length === 1 ? 'option' : 'options'}
                    </Badge>
                  )}
                  {isOpen ? (
                    <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
              </div>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="pt-0">
              <div className="space-y-1">
                {section.fields.map((field) => (
                  <ConfigFieldRenderer
                    key={field.key}
                    field={field}
                    value={values[field.key]}
                    onChange={(value) => handleFieldChange(field.key, value)}
                  />
                ))}
              </div>

              {section.subsections && section.subsections.length > 0 && (
                <div className="mt-4 space-y-3">
                  {section.subsections.map((sub) => renderSection(sub, sectionKey))}
                </div>
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    );
  }

  if (isLoading) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Loading configuration...
      </div>
    );
  }

  if (!config) {
    return (
      <div className="p-8 text-center text-destructive">
        Failed to load configuration
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {message && (
        <div className={`p-3 rounded-lg text-sm ${
          message.includes('Error')
            ? 'bg-destructive/10 border border-destructive/20 text-destructive'
            : 'bg-primary/10 border border-primary/20'
        }`}>
          {message}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{configFileName}</h3>
          <p className="text-sm text-muted-foreground">Format: {config.format.toUpperCase()}</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRevert}
            disabled={!hasChanges() || isSaving}
            className="rounded-sm"
          >
            <RotateCcw className="h-3 w-3 mr-1" />
            Revert
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!hasChanges() || isSaving}
            className="rounded-sm"
          >
            <Save className="h-3 w-3 mr-1" />
            {isSaving ? "Saving..." : "Save Changes"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            className="rounded-sm"
          >
            Close
          </Button>
        </div>
      </div>

      <Separator />

      <div className="space-y-3 max-h-[60vh] overflow-y-auto">
        {config.sections.map((section) => renderSection(section))}
      </div>
    </div>
  );
}
