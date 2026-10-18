#!/usr/bin/env bash
# Looks for secrets and personal data before the code goes public. Scans
#   1. the working tree: every file git tracks (plus untracked files that are not git-ignored),
#   2. the FULL history: every line ever added on any ref (`git log -p --all`) and every file name ever committed,
# for Google OAuth/API keys (GOCSPX-, AIza..., ya29.), OAuth client secrets, private keys, GitHub/AWS/Stripe/Slack tokens, JWTs,
# passwords in URLs, secret-bearing file names (.env, *.tfvars, *.tfstate, google-client.json, keys) and e-mail addresses.
# When `gitleaks` is installed it runs as well. A match is reported as file:line with a redacted prefix, never in full.
#
#   scripts/secret-scan.sh                          this repo: working tree + history
#   scripts/secret-scan.sh --tree DIR               a plain folder (no history), e.g. an export copy
#   scripts/secret-scan.sh --repo DIR               another git repo
#   --allow-email ADDR      an e-mail address that may appear (repeatable; "*@domain" allows a whole domain;
#                           SECRET_SCAN_ALLOW_EMAILS="me@example.org,*@example.net" works too)
#   --allow-rule RULE[:PREFIX]  silence one rule, everywhere or only under a path prefix (repeatable), e.g.
#                           client-secret-word:docs/example/   (rule names are shown in every finding)
#   --baseline FILE         accept findings listed in FILE (rule, path and a SHA-1 of the value; never the value itself)
#   --write-baseline FILE   write such a file from the current findings and exit 0. Review the findings first, keep the
#                           file OUTSIDE the repo, and any NEW finding (or a changed value) is still reported.
#   --no-history            skip the history scan        --no-gitleaks   do not run gitleaks even if installed
# A single line can be exempted by writing `secret-scan:allow` on it (use for deliberate fake fixtures).
# Exit status: 0 clean, 1 findings, 2 the scan itself failed.
set -euo pipefail

REPO=""
TREE=""
HISTORY=1
USE_GITLEAKS=1
ALLOW_EMAILS="${SECRET_SCAN_ALLOW_EMAILS:-}"
ALLOW_RULES=""
BASELINE=""
WRITE_BASELINE=""

usage() { sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) shift; REPO="${1:-}" ;;
    --tree) shift; TREE="${1:-}" ;;
    --allow-email) shift; ALLOW_EMAILS="${ALLOW_EMAILS:+$ALLOW_EMAILS,}${1:-}" ;;
    --allow-rule) shift; ALLOW_RULES="${ALLOW_RULES:+$ALLOW_RULES,}${1:-}" ;;
    --baseline) shift; BASELINE="${1:-}" ;;
    --write-baseline) shift; WRITE_BASELINE="${1:-}" ;;
    --no-history) HISTORY=0 ;;
    --no-gitleaks) USE_GITLEAKS=0 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
[ -z "$REPO" ] || [ -z "$TREE" ] || { echo "--repo and --tree exclude each other" >&2; exit 2; }
command -v perl >/dev/null 2>&1 || { echo "perl is required" >&2; exit 2; }
[ -z "$BASELINE" ] || [ -f "$BASELINE" ] || { echo "baseline not found: $BASELINE" >&2; exit 2; }

IFS= read -r -d '' PERL_SRC <<'PERL' || true
use strict;
use warnings;
use Digest::SHA qw(sha1_hex);

my ($mode, $root, $where) = @ARGV;   # mode: files | history | names
$where //= '';

my %baseline;
if (length($ENV{SS_BASELINE} // '')) {
  open(my $b, '<', $ENV{SS_BASELINE}) or die "cannot read baseline $ENV{SS_BASELINE}: $!\n";
  while (my $l = <$b>) { chomp $l; next if $l =~ /^#/ || !length $l; $baseline{$l} = 1 }
  close $b;
}
my $write_baseline = $ENV{SS_WRITE_BASELINE} // '';
my ($suppressed, %to_write) = (0);

my (%allow_email, @allow_domain, @allow_rules);
for my $e (grep { length } split /,/, ($ENV{SS_ALLOW_EMAILS} // '')) {
  $e = lc $e;
  $e =~ s/^\s+|\s+$//g;
  if ($e =~ /^\*@(.+)$/) { push @allow_domain, $1 } else { $allow_email{$e} = 1 }
}
for my $r (grep { length } split /,/, ($ENV{SS_ALLOW_RULES} // '')) {
  my ($rule, $prefix) = split /:/, $r, 2;
  push @allow_rules, [$rule, $prefix // ''];
}
sub rule_allowed {
  my ($rule, $path) = @_;
  for my $a (@allow_rules) {
    next unless $a->[0] eq $rule;
    return 1 if $a->[1] eq '' || index($path, $a->[1]) == 0;
  }
  return 0;
}

# A password or secret value that is obviously a placeholder is not a finding.
sub placeholder {
  my ($v) = @_;
  return 1 if $v =~ /^[\$\{<%\[\*]/ || $v =~ /\.\.\./;
  return 1 if $v =~ /^(?:x+|password|pass|secret|changeme|example|user|token|your[-_a-z]*|redacted)$/i;
  return 0;
}

my @rules = (
  ['google-oauth-client-secret', qr/GOCSPX-[A-Za-z0-9_-]{10,}/, undef],
  ['google-api-key',             qr/AIza[0-9A-Za-z_-]{35}/, undef],
  ['google-oauth-token',         qr/ya29\.[0-9A-Za-z_-]{10,}/, undef],
  ['client-secret-value',        qr/client_secret["']?\s*[:=]\s*["']([^"'\s]{6,})["']/i, sub { !placeholder($_[1]) }],   # secret-scan:allow
  ['client-secret-word',         qr/client_secret/i, undef],   # secret-scan:allow
  ['private-key',                qr/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/, undef],
  ['github-token',               qr/\bgh[pousr]_[A-Za-z0-9]{30,}/, undef],
  ['github-pat',                 qr/github_pat_[A-Za-z0-9_]{22,}/, undef],
  ['aws-access-key',             qr/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, undef],
  ['stripe-live-key',            qr/sk_live_[0-9A-Za-z]{10,}/, undef],
  ['slack-token',                qr/xox[baprs]-[0-9A-Za-z-]{10,}/, undef],
  ['jwt',                        qr/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, undef],
  ['url-password-param',         qr{\b[a-z][a-z0-9+.-]*://[^\s'"]*[?&;]password=([^&\s'"]{3,})}i, sub { !placeholder($_[1]) }],
  ['url-credentials',            qr{\b[a-z][a-z0-9+.-]*://([^\s/:@'"<>]+):([^\s/@'"<>]+)@}i, sub { !placeholder($_[2]) && $_[1] ne $_[2] }],
);
my $email_re = qr/[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/;
my %asset_ext = map { $_ => 1 } qw(png jpg jpeg gif webp svg ico css js ts tsx jsx json md woff woff2 ttf map patch);

sub email_ok {
  my ($addr) = @_;
  my $a = lc $addr;
  return 1 if $allow_email{$a};
  my ($local, $domain) = split /@/, $a, 2;
  return 1 if grep { $domain eq $_ } @allow_domain;
  my ($tld) = $domain =~ /\.([a-z]+)$/;
  return 1 if $tld && $asset_ext{$tld};                                  # logo@2x.png, heroui-native@1.0.7.patch
  return 1 if $domain =~ /^(?:\d+\.)+[a-z]+$/;                            # pkg@1.2.3.tgz
  return 1 if $domain eq 'system.gserviceaccount.com';                   # Google's public token-signer account
  return 1 if $domain =~ /\.example$/;
  return 1 if $domain =~ /(?:^|\.)example\.(?:com|org|net)$/;
  return 1 if $domain =~ /(?:^|\.)(?:localhost|test|invalid|local|internal)$/;
  return 1 if $domain eq 'users.noreply.github.com' || $domain eq 'noreply.github.com';
  return 1 if $local eq 'git' && $domain eq 'github.com';
  return 0;
}

sub redact {
  my ($rule, $m) = @_;
  if ($rule eq 'email') {
    my ($l, $d) = split /@/, $m, 2;
    return substr($l, 0, 2) . '***@' . $d;
  }
  my $n = length $m;
  return substr($m, 0, $n > 12 ? 4 : 0) . '...[' . $n . ' chars]';
}

my @name_rules = (
  ['env-file',             qr/^\.env(?:\..+)?$/],
  ['tfvars-file',          qr/\.tfvars(?:\.json)?$/],
  ['tfstate-file',         qr/\.tfstate(?:\..+)?$/],
  ['google-client-json',   qr/^google-client\.json$/],
  ['service-account-json', qr/^service-account.*\.json$/i],
  ['private-key-file',     qr/\.(?:pem|p12|pfx|key|jks|keystore|p8)$/i],
  ['ssh-private-key',      qr/^id_(?:rsa|dsa|ecdsa|ed25519)$/],
);

my (%seen, @order, %by_rule);
my $findings = 0;

sub note_finding {
  my (%f) = @_;      # rule path line value commit
  my $key = join "\0", $f{rule}, $f{path}, $f{value};
  if (my $s = $seen{$key}) { $s->{count}++; return; }
  my $bk = join "\t", $f{rule}, $f{path}, sha1_hex($f{value});
  if ($baseline{$bk}) { $suppressed++; $seen{$key} = { count => 0 }; return; }
  $to_write{$bk} = 1;
  $seen{$key} = { %f, count => 1 };
  push @order, $key;
  $by_rule{$f{rule}}++;
  $findings++;
}

sub check_name {
  my ($path, $commit) = @_;
  (my $base = $path) =~ s{.*/}{};
  return if $base =~ /(?:^example\.|\.example(?:\.|$)|\.sample$|\.template$|\.dist$)/;   # .env.example, example.tfvars
  for my $r (@name_rules) {
    next unless $base =~ $r->[1];
    next if rule_allowed($r->[0], $path);
    note_finding(rule => $r->[0], path => $path, line => 0, value => $base, commit => $commit, kind => 'name');
  }
}

sub scan_line {
  my ($line, $path, $lineno, $commit) = @_;
  return if index($line, 'secret-scan:allow') >= 0;
  $line = substr($line, 0, 100000) if length($line) > 100000;
  my %hit;
  for my $r (@rules) {
    my ($name, $re, $check) = @$r;
    next if rule_allowed($name, $path);
    while ($line =~ /$re/g) {
      my ($m, $g1, $g2) = ($&, $1, $2);
      next if $check && !$check->($m, $g1, $g2);
      $hit{$name}{$m} = 1;
    }
  }
  delete $hit{'client-secret-word'} if $hit{'client-secret-value'};
  if (!rule_allowed('email', $path)) {
    while ($line =~ /($email_re)/g) {
      my $addr = $1;
      next if substr($line, 0, $-[1]) =~ m{://[^\s/@]*:$};     # user:password@host is a credential, not an address
      next if email_ok($addr);
      $hit{email}{$addr} = 1;
    }
  }
  for my $name (keys %hit) {
    for my $m (keys %{ $hit{$name} }) {
      note_finding(rule => $name, path => $path, line => $lineno, value => $m, commit => $commit, kind => 'line');
    }
  }
}

my ($files, $lines) = (0, 0);
if ($mode eq 'files') {
  local $/ = "\0";
  while (my $rel = <STDIN>) {
    chomp $rel;
    next unless length $rel;
    $rel =~ s{^\./}{};
    my $abs = "$root/$rel";
    next if -l $abs || !-f $abs;
    check_name($rel, '');
    open(my $fh, '<:raw', $abs) or next;
    read($fh, my $head, 8000);
    if (defined $head && index($head, "\0") >= 0) { close $fh; next; }   # binary
    seek($fh, 0, 0);
    $files++;
    local $/ = "\n";
    while (my $line = <$fh>) {
      $lines++;
      scan_line($line, $rel, $., '');
    }
    close $fh;
  }
} elsif ($mode eq 'names') {
  while (my $p = <STDIN>) {
    chomp $p;
    next unless length $p;
    $files++;
    check_name($p, 'history');
  }
} elsif ($mode eq 'history') {
  my ($commit, $file, $lineno, $in_hunk) = ('', '', 0, 0);
  while (my $l = <STDIN>) {
    chomp $l;
    if ($l =~ /^\@\@COMMIT\@\@ ([0-9a-f]{40})/) { $commit = substr($1, 0, 10); $in_hunk = 0; $file = ''; next; }
    if ($in_hunk) {
      my $c = substr($l, 0, 1);
      if ($c eq '+') { $lineno++; $lines++; scan_line(substr($l, 1), $file, $lineno, $commit); next; }
      next if $c eq '-' || $c eq ' ' || $c eq '\\';
    }
    if ($l =~ /^diff --git /) { $in_hunk = 0; $file = ''; next; }
    if ($l =~ /^\+\+\+ b\/(.*?)(?:\t.*)?$/) { $file = $1; next; }
    if ($l =~ /^\@\@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? \@\@/) { $lineno = $1 - 1; $in_hunk = 1; next; }
  }
}

for my $key (@order) {
  my $f = $seen{$key};
  my $loc = $f->{kind} eq 'name' ? $f->{path} : "$f->{path}:$f->{line}";
  $loc = "$f->{commit}:$loc" if $mode eq 'history' && $f->{kind} eq 'line';
  my $what = $f->{kind} eq 'name' ? 'file name' : redact($f->{rule}, $f->{value});
  my $more = $f->{count} > 1 ? "  (seen $f->{count}x)" : '';
  print "  FOUND  $loc  [$f->{rule}]  $what$more\n";
}
if (length $write_baseline) {
  open(my $w, '>>', $write_baseline) or die "cannot write $write_baseline: $!\n";
  print $w "$_\n" for sort keys %to_write;
  close $w;
}
my $by = join ', ', map { "$_ x$by_rule{$_}" } sort keys %by_rule;
printf "  %s: scanned %d %s%s, %d finding%s%s\n", $where, $files, ($mode eq 'names' ? 'paths' : 'files'),
  ($lines ? ", $lines lines" : ''), $findings, ($findings == 1 ? '' : 's'), ($findings ? " ($by)" : '');
print "  accepted by the baseline: $suppressed\n" if $suppressed;
exit(($findings && !length $write_baseline) ? 1 : 0);
PERL

export SS_ALLOW_EMAILS="$ALLOW_EMAILS" SS_ALLOW_RULES="$ALLOW_RULES" SS_BASELINE="$BASELINE" SS_WRITE_BASELINE="$WRITE_BASELINE"
if [ -n "$WRITE_BASELINE" ]; then
  printf '# secret-scan baseline: rule<TAB>path<TAB>sha1(value). No values. Keep this file out of the repo.\n' >"$WRITE_BASELINE"
fi
perl_scan() { perl -e "$PERL_SRC" -- "$@"; }

STATUS=0
note_rc() { # note_rc EXIT_CODE: 1 means findings, anything else non-zero means the scan itself broke
  case "$1" in
    0) ;;
    1) [ "$STATUS" -ne 0 ] || STATUS=1 ;;
    *) STATUS=2 ;;
  esac
}

if [ -n "$TREE" ]; then
  [ -d "$TREE" ] || { echo "not a directory: $TREE" >&2; exit 2; }
  TREE="$(cd "$TREE" && pwd)"
  echo "== folder $TREE (no history) =="
  rc=0
  (cd "$TREE" && find . -type f -not -path '*/.git/*' -print0) | perl_scan files "$TREE" "files" || rc=$?
  note_rc "$rc"
  top="$TREE"
else
  top="$(git -C "${REPO:-.}" rev-parse --show-toplevel)" || { echo "not a git repository: ${REPO:-.}" >&2; exit 2; }
  echo "== working tree of $top (tracked files, plus untracked files that are not ignored) =="
  rc=0
  git -C "$top" ls-files -z --cached --others --exclude-standard | perl_scan files "$top" "working tree" || rc=$?
  note_rc "$rc"
  if [ "$HISTORY" = 1 ]; then
    if git -C "$top" rev-parse --verify -q HEAD >/dev/null 2>&1; then
      echo "== history of $top (every added line on every ref, every file name ever committed) =="
      rc=0
      git -C "$top" -c core.quotepath=false log --all --no-color --no-ext-diff --no-textconv -U0 -p \
        --format='@@COMMIT@@ %H' | perl_scan history "$top" "history lines" || rc=$?
      note_rc "$rc"
      rc=0
      git -C "$top" -c core.quotepath=false log --all --name-only --no-renames --format= | sort -u |
        perl_scan names "$top" "history file names" || rc=$?
      note_rc "$rc"
    else
      echo "== history: no commits yet =="
    fi
  fi
fi

# gitleaks, when present, in addition to the rules above (it redacts its own output).
if [ "$USE_GITLEAKS" = 1 ] && command -v gitleaks >/dev/null 2>&1; then
  echo "== gitleaks =="
  rc=0
  if gitleaks git --help >/dev/null 2>&1; then
    if [ -n "$TREE" ]; then
      gitleaks dir "$top" --redact --no-banner --verbose || rc=$?
    elif [ "$HISTORY" = 1 ] && git -C "$top" rev-parse --verify -q HEAD >/dev/null 2>&1; then
      gitleaks git "$top" --redact --no-banner --verbose --log-opts="--all" || rc=$?
    fi
  else
    if [ -n "$TREE" ]; then
      gitleaks detect --no-git --source "$top" --redact --no-banner --verbose || rc=$?
    elif [ "$HISTORY" = 1 ] && git -C "$top" rev-parse --verify -q HEAD >/dev/null 2>&1; then
      gitleaks detect --source "$top" --redact --no-banner --verbose --log-opts="--all" || rc=$?
    fi
  fi
  note_rc "$rc"
else
  echo "== gitleaks: $([ "$USE_GITLEAKS" = 1 ] && echo 'not installed, skipped (brew install gitleaks)' || echo 'disabled') =="
fi

echo
if [ -n "$WRITE_BASELINE" ]; then
  { head -n 1 "$WRITE_BASELINE"; tail -n +2 "$WRITE_BASELINE" | sort -u; } >"$WRITE_BASELINE.tmp" && mv "$WRITE_BASELINE.tmp" "$WRITE_BASELINE"
  echo "secret-scan: baseline written to $WRITE_BASELINE ($(($(wc -l <"$WRITE_BASELINE") - 1)) entries). It accepts exactly these findings from now on."
  exit 0
fi
case "$STATUS" in
  0) echo "secret-scan: clean" ;;
  1) echo "secret-scan: FINDINGS above. Nothing was printed in full; open each file:line yourself. Do not publish until each is resolved or deliberately allowed." >&2 ;;
  *) echo "secret-scan: the scan itself failed (exit 2); treat the result as unknown" >&2 ;;
esac
exit "$STATUS"
