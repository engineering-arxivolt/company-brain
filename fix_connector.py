import re
with open('src/brain/tools/mcp/connector.ts', 'r') as f:
    content = f.read()
# Fix the fourth occurrence - insert retryable: true before the closing }),
# Find the pattern for the fourth invalid_arguments error
pattern = r'(\s+"Inspect the nested operation schema, then retry with the documented command grammar\.\",\n\s+traceId: this\.target\.traceId,\n\s+}),)'
replacement = r'\1\n\t\t\t\t\t\t\tretryable: true,'
content = re.sub(pattern, replacement, content)
with open('src/brain/tools/mcp/connector.ts', 'w') as f:
    f.write(content)
print('Done')
