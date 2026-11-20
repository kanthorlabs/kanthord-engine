The merge of origin/{{base_branch}} into the node branch of repository {{binding}} in directory `{{directory}}` conflicts. Resolve every conflict in these files of that directory so that the base branch change and the node work both stay intact: {{files}}. Remove every conflict marker. A conflicted file with no conflict marker is a modify/delete or a binary conflict: in that directory, run `git add -- <file>` to keep it, or `git rm -- <file>` to delete it. The worker commits. Do not abort the merge.

The base branch change of each conflicted file follows: the commits and the diff from the merge base to origin/{{base_branch}}. Keep each of these changes in the merged file.

{{base_changes}}
