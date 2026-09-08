import codecs

p = r'src/App.jsx'
f = codecs.open(p, 'r', 'utf-8')
lines = f.readlines()
f.close()

decls = [i for i, l in enumerate(lines) if l.strip() == 'const recorder = useScreenRecorder({ onCommit: commitRecording })']
print(f"Found recorder decls at lines: {[i+1 for i in decls]}")

if len(decls) == 2:
    dup = decls[1]
    # Remove from the comment block start (4 lines before decl) through the decl
    start = dup - 4
    end = dup  # inclusive
    print(f"Removing lines {start+1} to {end+1}")
    del lines[start:end+1]
else:
    print(f"ERROR: expected 2 decls, found {len(decls)}")

f = codecs.open(p, 'w', 'utf-8')
f.writelines(lines)
f.close()
print("DONE")