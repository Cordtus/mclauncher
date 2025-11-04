import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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

interface ConfigFieldRendererProps {
  field: ConfigField;
  value: any;
  onChange: (value: any) => void;
}

export function ConfigFieldRenderer({ field, value, onChange }: ConfigFieldRendererProps) {
  const displayName = field.key.split('.').pop() || field.key;
  const formattedName = displayName
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (str) => str.toUpperCase())
    .trim();

  function renderField() {
    // Boolean field
    if (field.type === 'boolean') {
      return (
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div className="flex-1">
            <Label htmlFor={field.key} className="text-sm font-semibold">
              {formattedName}
            </Label>
            {field.description && (
              <p className="text-xs text-muted-foreground mt-1">{field.description}</p>
            )}
          </div>
          <Switch
            id={field.key}
            checked={value === true}
            onCheckedChange={onChange}
            className="data-[state=checked]:bg-green-500"
          />
        </div>
      );
    }

    // Enum/Select field
    if (field.constraints?.options && field.constraints.options.length > 0) {
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label htmlFor={field.key} className="text-sm font-semibold">
              {formattedName}
            </Label>
            {field.description && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <Info className="h-3 w-3 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <p className="text-xs">{field.description}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <Select value={String(value)} onValueChange={onChange}>
            <SelectTrigger id={field.key} className="rounded-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {field.constraints.options.map((option) => (
                <SelectItem key={String(option)} value={String(option)}>
                  {String(option)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );
    }

    // Number field
    if (field.type === 'number') {
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label htmlFor={field.key} className="text-sm font-semibold">
              {formattedName}
            </Label>
            {field.description && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <Info className="h-3 w-3 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <p className="text-xs">{field.description}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <Input
            id={field.key}
            type="number"
            value={value}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            min={field.constraints?.min}
            max={field.constraints?.max}
            step={Number.isInteger(field.value) ? 1 : 0.1}
            className="rounded-sm"
          />
          {(field.constraints?.min !== undefined || field.constraints?.max !== undefined) && (
            <p className="text-xs text-muted-foreground">
              Range: {field.constraints?.min ?? '-∞'} to {field.constraints?.max ?? '∞'}
            </p>
          )}
        </div>
      );
    }

    // String field (multiline if long)
    if (field.type === 'string') {
      const isLong = typeof value === 'string' && value.length > 100;

      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label htmlFor={field.key} className="text-sm font-semibold">
              {formattedName}
            </Label>
            {field.description && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <Info className="h-3 w-3 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <p className="text-xs">{field.description}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          {isLong ? (
            <Textarea
              id={field.key}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className="rounded-sm font-mono text-xs"
              rows={4}
            />
          ) : (
            <Input
              id={field.key}
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className="rounded-sm"
              pattern={field.constraints?.pattern}
            />
          )}
        </div>
      );
    }

    // Array field (simplified - just show as JSON)
    if (field.type === 'array') {
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label htmlFor={field.key} className="text-sm font-semibold">
              {formattedName}
            </Label>
            {field.description && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <Info className="h-3 w-3 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <p className="text-xs">{field.description}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <Textarea
            id={field.key}
            value={JSON.stringify(value, null, 2)}
            onChange={(e) => {
              try {
                onChange(JSON.parse(e.target.value));
              } catch (err) {
                // Ignore parse errors during typing
              }
            }}
            className="rounded-sm font-mono text-xs"
            rows={4}
          />
          <p className="text-xs text-muted-foreground">JSON array format</p>
        </div>
      );
    }

    // Object field (simplified - show as JSON)
    if (field.type === 'object') {
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label htmlFor={field.key} className="text-sm font-semibold">
              {formattedName}
            </Label>
            {field.description && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <Info className="h-3 w-3 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <p className="text-xs">{field.description}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <Textarea
            id={field.key}
            value={JSON.stringify(value, null, 2)}
            onChange={(e) => {
              try {
                onChange(JSON.parse(e.target.value));
              } catch (err) {
                // Ignore parse errors during typing
              }
            }}
            className="rounded-sm font-mono text-xs"
            rows={6}
          />
          <p className="text-xs text-muted-foreground">JSON object format</p>
        </div>
      );
    }

    return null;
  }

  return <div className="py-2">{renderField()}</div>;
}
