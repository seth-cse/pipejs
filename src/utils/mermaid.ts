import { Pipeline, Task, TaskExecution, MermaidOutput, VisualizationOptions } from '../types.js';

export class MermaidGenerator {
  generate(pipeline: Pipeline, executions?: Map<string, TaskExecution>, options: VisualizationOptions = {}): MermaidOutput {
    const errors: string[] = [];
    
    try {
      const orientation = options.orientation || 'TB';
      const theme = options.theme || 'default';
      const showDescriptions = options.showDescriptions ?? true;
      const showStatus = options.showStatus ?? true;

      let mermaid = `flowchart ${orientation}\n`;
      
      // Apply theme
      if (theme !== 'default') {
        mermaid += `%%{init: {'theme':'${theme}'}}%%\n`;
      }

      // Build task nodes
      const taskNodes = new Map<string, string>();
      
      for (const task of pipeline.tasks) {
        if (!task.enabled) continue;

        const nodeId = this.sanitizeId(task.id);
        taskNodes.set(task.id, nodeId);

        const status = executions?.get(task.id)?.status;
        const statusStyle = this.getStatusStyle(status);
        
        let label = task.name;
        if (showDescriptions && task.description) {
          label += `\\n<small>${this.escapeText(task.description)}</small>`;
        }
        if (showStatus && status) {
          label += `\\n[${status}]`;
        }

        mermaid += `    ${nodeId}${statusStyle}[${this.escapeText(label)}]\\n`;
      }

      // Build dependencies
      for (const task of pipeline.tasks) {
        if (!task.enabled) continue;

        const taskId = taskNodes.get(task.id);
        if (!taskId) continue;

        if (task.dependsOn && task.dependsOn.length > 0) {
          for (const depId of task.dependsOn) {
            const depNodeId = taskNodes.get(depId);
            if (depNodeId) {
              mermaid += `    ${depNodeId} --> ${taskId}\\n`;
            } else {
              errors.push(`Dependency not found: ${depId} -> ${task.id}`);
            }
          }
        }
      }

      // Add styling for status
      if (showStatus && executions) {
        mermaid += this.generateStatusStyles(executions);
      }

      return {
        mermaid: mermaid.trim(),
        errors
      };
    } catch (error) {
      errors.push(`Failed to generate Mermaid diagram: ${error instanceof Error ? error.message : String(error)}`);
      return {
        mermaid: '',
        errors
      };
    }
  }

  private sanitizeId(id: string): string {
    // Mermaid IDs must be alphanumeric, replace invalid chars with underscores
    return id.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  private escapeText(text: string): string {
    // Escape Mermaid special characters
    return text
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\|/g, '\\|')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/\n/g, '<br/>');
  }

  private getStatusStyle(status?: string): string {
    switch (status) {
      case 'success':
        return ':::success';
      case 'running':
        return ':::running';
      case 'failed':
        return ':::failed';
      case 'pending':
        return ':::pending';
      default:
        return '';
    }
  }

  private generateStatusStyles(executions: Map<string, TaskExecution>): string {
    const styles = `
    classDef success fill:#d4edda,stroke:#155724,stroke-width:2px
    classDef running fill:#d1ecf1,stroke:#0c5460,stroke-width:2px
    classDef failed fill:#f8d7da,stroke:#721c24,stroke-width:2px
    classDef pending fill:#fff3cd,stroke:#856404,stroke-width:2px
    `;

    // Apply classes to nodes
    let classApplications = '';
    for (const [taskId, execution] of executions) {
      const nodeId = this.sanitizeId(taskId);
      const status = execution.status;
      
      if (status && status !== 'pending') {
        classApplications += `    class ${nodeId} ${status}\\n`;
      }
    }

    return styles + (classApplications ? `\\n${classApplications}` : '');
  }

  validateMermaid(code: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Basic Mermaid syntax validation
    if (!code.includes('flowchart')) {
      errors.push('Missing flowchart declaration');
    }

    if (!code.match(/[a-zA-Z_][a-zA-Z0-9_]*\[[^\]]*\]/)) {
      errors.push('No valid node definitions found');
    }

    // Check for common syntax issues
    const lines = code.split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      
      if (trimmed.startsWith('-->') && !trimmed.match(/[a-zA-Z_][a-zA-Z0-9_]*\s*-->\s*[a-zA-Z_][a-zA-Z0-9_]*/)) {
        errors.push(`Invalid edge syntax at line ${index + 1}: ${trimmed}`);
      }
    });

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

// Default Mermaid generator instance
export const mermaid = new MermaidGenerator();