#!/bin/bash

# Install Kippy logo to Material Icon Theme (points to source, no copy)

LOGO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGO_PATH="$LOGO_DIR/kip.svg"
MATERIAL_ICONS_DIR="$HOME/Library/Application Support/Zed/extensions/installed/material-icon-theme"
ICONS_DIR="$MATERIAL_ICONS_DIR/icons"
JSON_FILE="$MATERIAL_ICONS_DIR/icon_themes/material-icon-theme.json"

echo "Installing Kippy logo to Material Icon Theme..."

# Check if Material Icon Theme is installed
if [ ! -d "$MATERIAL_ICONS_DIR" ]; then
    echo "Error: Material Icon Theme not found at $MATERIAL_ICONS_DIR"
    exit 1
fi

# Check if logo exists
if [ ! -f "$LOGO_PATH" ]; then
    echo "Error: Logo not found at $LOGO_PATH"
    exit 1
fi

# Copy logo to icons folder
echo "Copying kip.svg to Material Icon Theme icons folder..."
cp "$LOGO_PATH" "$ICONS_DIR/kip.svg"

if [ $? -ne 0 ]; then
    echo "Error: Failed to copy logo"
    exit 1
fi

# Update JSON to use relative paths
echo "Adding kip/kippy entries to icon theme JSON..."

python3 << EOF
import json

json_file = '$JSON_FILE'
icon_path = './icons/kip.svg'

with open(json_file, 'r') as f:
    data = json.load(f)

added = []

for name in ['kip', 'kippy', 'Kip', 'Kippy']:
    if name not in data['themes'][0]['file_icons']:
        data['themes'][0]['file_icons'][name] = {
            'path': icon_path
        }
        added.append(name)

if added:
    with open(json_file, 'w') as f:
        json.dump(data, f, indent=2)
    print(f'Added {", ".join(added)} to icon theme')
else:
    print('kip and kippy already in icon theme')
EOF

echo "✓ Kippy logo installed successfully!"
echo "  Copied to: $ICONS_DIR/kip.svg"
echo "  Icon theme: $JSON_FILE"
