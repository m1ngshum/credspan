# Public source previews

The first release candidate is **v0.1.0-preview.1**. Distribute one source archive and its manifest through GitHub Releases. Use `v0.MINOR.PATCH-preview.N` tags and mark every preview as a pre-release. The source archive is architecture-neutral. Its runtime and deployment limits are still those in [compatibility](compatibility.md) and [security](../SECURITY.md). Any later stable version or prebuilt image needs its own scope and qualification.

GitHub Releases keeps versioned notes, the immutable tag, and the reviewed files together. GHCR would be the natural place to evaluate container distribution if adopters need a prebuilt image. Docker Hub would add a second registry to maintain and verify, so defer it until there is a distinct need. This process distributes no API or wallet images, npm packages, deployment bundle, or compiled binaries. It leaves the [private artifact workflow](operations.md) separate.

## Prepare and review

1. Use a clean reviewed commit on protected `main` with passing CI for its exact SHA. Dispatch [Prepare public source preview](../.github/workflows/source-preview.yml) from `main` with the planned version. The workflow verifies the exact main CI run and packages only committed source. It has read-only permissions, no signing secrets, and no tag or publishing step.
2. Download `source-preview-candidate` from the successful dispatch. It expires in seven days. Record the run, version, commit, tree, archive length and SHA-256 from `source-preview.json`. Verify the archive bytes and embedded commit identifier using the commands below. Review the contents against the commit. Retain the actual downloaded files through publication. If they are lost, prepare and review a new candidate.
3. Review the current [security policy](../SECURITY.md), dependency and compatibility notes, and redistribution notices in the archive. The archive includes the project license, upstream notices and patches. The dependency manifests and lockfile identify source dependencies. There is no packaged runtime to inventory or scan, so image SBOMs, runtime scans, image signatures and architecture qualification are outside this source artifact. Review applicable source and dependency findings before approving the preview. GitHub's immutable release attestation covers the tag, commit, and uploaded assets once published.
4. Prepare versioned notes using the [preview notes draft](source-preview-notes.md). Use the reviewed diff and Conventional Commits as inputs. State compatibility and recovery limits, and keep private planning details and sensitive security evidence out of public notes. Review the notes together with the exact archive and manifest.

From inside the downloaded artifact directory, set `version` and `commit` to the reviewed values and `trusted_checkout` to the path of a canonical Git checkout containing that commit:

```sh
(
set -eu
archive="credspan-${version}.tar.gz"
test "$(jq -r .version source-preview.json)" = "$version"
test "$(jq -r .commit source-preview.json)" = "$commit"
test "$(jq -r .tree source-preview.json)" = "$(git -C "$trusted_checkout" rev-parse "$commit^{tree}")"
test "$(jq -r .archive source-preview.json)" = "$archive"
test "$(shasum -a 256 "$archive" | cut -d ' ' -f 1)" = "$(jq -r .sha256 source-preview.json)"
test "$(wc -c < "$archive" | tr -d '[:space:]')" = "$(jq -r .bytes source-preview.json)"
scratch=$(mktemp -d)
trap 'rm -r "$scratch"' EXIT
gzip -dc "$archive" > "$scratch/downloaded.tar"
test "$(git get-tar-commit-id < "$scratch/downloaded.tar")" = "$commit"
git -C "$trusted_checkout" -c tar.umask=0002 archive --format=tar \
  --prefix="credspan-${version}/" "$commit" > "$scratch/expected.tar"
cmp "$scratch/downloaded.tar" "$scratch/expected.tar"
)
```

Stop if any check fails. For a local packaging dry run, run `node ops/source-preview.mjs "$version" "$commit" "$output"` from the checkout at the exact commit, using a new output directory. Local packaging verifies source identity but does not check hosted CI or generate a release attestation. The source archive is for inspection. Clone the canonical Git tag for the developer setup because the build and checks require Git metadata.

## Promote the reviewed bytes

First verify that immutable releases are enabled, `main` is protected, and the intended tag is unused. Restrict release and tag authority to maintainers. A human maintainer publishes only after explicit approval of the exact version, SHA, archive hash, notes and GitHub destination. Tag creation is part of that approval because a tag is visible even before release publication. The candidate workflow cannot publish. Use existing maintainer authentication with no additional long-lived release credential.

After approval, in a trusted checkout of the canonical repository, create an annotated tag at the approved commit and push just that ref. Use absolute paths to the approved files when creating the draft.

```sh
(
set -eu
repo=m1ngshum/credspan
git tag -a "$version" "$commit" -m "Credspan $version"
git push origin "refs/tags/$version"
test "$(git ls-remote --tags origin "refs/tags/$version^{}" | cut -f 1)" = "$commit"
gh release create "$version" --repo "$repo" --verify-tag --draft --prerelease \
  --title "Credspan $version" --notes-file "$approved_notes" \
  "$approved_directory/credspan-${version}.tar.gz" "$approved_directory/source-preview.json"
)
```

Confirm the remote peeled tag matches the approved commit (`git ls-remote --tags origin "refs/tags/$version^{}"`). Verify the draft's title, notes, pre-release flag and both files. Download the draft files as a maintainer and compare their bytes with the approved files. Publish that draft only after the comparisons pass. If draft creation or upload fails, inspect the remote tag and draft before retrying. Reuse a matching tag and the same verified bytes. Stop on any mismatched tag, asset or notes.

## Verify and recover

After publication, confirm the release is public, immutable and marked as a pre-release. Fetch both uploaded files anonymously from `https://github.com/m1ngshum/credspan/releases/download/$version/` with `curl -fsSL`, then repeat the manifest and archive checks. Compare with the approved hashes. Run `gh release verify "$version" --repo "$repo"` and `gh release verify-asset "$version" "$archive" --repo "$repo"`. Also verify `source-preview.json` with `gh release verify-asset`. Record the public URLs, tag, commit, digest, verification results and any remaining limitations. Use the uploaded, attested archive for verification, since GitHub also displays automatically generated source downloads.

If read-back or verification fails, pause promotion and investigate. Correct mistakes with a new reviewed preview number. Never retag or swap published bytes. Source preview rollback changes which code an operator chooses to run. It does not restore credential state. For recovery involving saved credentials use the [operations runbook](operations.md) before starting any older runtime.

Provider references checked 2026-11-20: [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases), [release immutability](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases), [release verification](https://cli.github.com/manual/gh_release_verify), [asset verification](https://cli.github.com/manual/gh_release_verify-asset), [GHCR](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry), and [Docker Hub](https://docs.docker.com/docker-hub/repos/manage/hub-images/push/).
