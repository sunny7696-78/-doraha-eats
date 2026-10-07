import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, View, StyleSheet, Switch, TextInput, Alert, Pressable } from 'react-native';
import { Screen, AppText, LoadingBlock, Button, Card, VegDot, ErrorState } from '../../src/components/ui';
import { colors, spacing } from '../../src/theme/tokens';
import {
  getVendorMenu, setItemAvailability, createMenuSection, createMenuItem, deleteMenuItem,
  type MenuSectionAdmin,
} from '../../src/features/vendor/api';
import { ApiError } from '../../src/lib/api';
import { formatPaise } from '../../src/lib/money';

export default function VendorMenuScreen() {
  const [sections, setSections] = useState<MenuSectionAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newSection, setNewSection] = useState('');
  const [addingTo, setAddingTo] = useState<string | null>(null); // sectionId with the open form
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [isVeg, setIsVeg] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setError(null); setSections((await getVendorMenu()).sections); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Could not load your menu.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Prices are stored as integer paise. Rupees typed here are converted once, never as floats in the DB.
  const toPaise = (text: string) => Math.round(parseFloat(text.replace(/[^0-9.]/g, '')) * 100);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); await load(); }
    catch (e) { Alert.alert('Could not save', e instanceof ApiError ? e.message : 'Please try again.'); }
    finally { setBusy(false); }
  }

  const addSection = () => {
    if (!newSection.trim()) return;
    act(async () => { await createMenuSection(newSection.trim()); setNewSection(''); });
  };

  const addItem = (sectionId: string) => {
    const pricePaise = toPaise(price);
    if (!name.trim()) return Alert.alert('Enter the dish name.');
    if (!Number.isFinite(pricePaise) || pricePaise < 100) return Alert.alert('Enter a price of at least Rs 1.');
    act(async () => {
      await createMenuItem({ name: name.trim(), pricePaise, sectionId, isVeg });
      setName(''); setPrice(''); setIsVeg(true); setAddingTo(null);
    });
  };

  const toggle = (itemId: string, current: boolean) =>
    act(() => setItemAvailability(itemId, !current));

  const remove = (itemId: string, itemName: string) =>
    Alert.alert('Delete dish?', `${itemName} will be removed from your menu.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => act(() => deleteMenuItem(itemId)) },
    ]);

  if (loading) return <Screen><LoadingBlock /></Screen>;
  if (error) return <Screen><ErrorState message={error} onRetry={load} /></Screen>;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: spacing.lg }} keyboardShouldPersistTaps="handled">
        <Card style={{ marginBottom: spacing.lg }}>
          <AppText variant="h3" style={{ marginBottom: spacing.sm }}>Add a menu section</AppText>
          <TextInput value={newSection} onChangeText={setNewSection} placeholder="e.g. Burgers, Drinks" style={styles.input} />
          <Button onPress={addSection} loading={busy}>Add section</Button>
        </Card>

        {sections.length === 0 && (
          <AppText variant="body" color={colors.textMuted}>
            Your menu is empty. Add a section first, then add your dishes to it.
          </AppText>
        )}

        {sections.map((section) => (
          <View key={section.id} style={{ marginBottom: spacing.lg }}>
            <AppText variant="h3" style={{ marginBottom: spacing.sm }}>{section.name}</AppText>
            {section.foodItems.map((item) => (
              <View key={item.id} style={styles.row}>
                <VegDot isVeg={item.isVeg} />
                <View style={{ flex: 1, marginLeft: spacing.sm }}>
                  <AppText variant="bodyBold">{item.name}</AppText>
                  <AppText variant="caption" color={colors.textMuted}>{formatPaise(item.pricePaise)}</AppText>
                </View>
                <Switch value={item.isAvailable} onValueChange={() => toggle(item.id, item.isAvailable)} trackColor={{ true: colors.primary }} />
                <Pressable onPress={() => remove(item.id, item.name)} hitSlop={10} style={{ marginLeft: spacing.md }}>
                  <AppText variant="caption" color={colors.danger}>Delete</AppText>
                </Pressable>
              </View>
            ))}

            {addingTo === section.id ? (
              <Card style={{ marginTop: spacing.sm }}>
                <TextInput value={name} onChangeText={setName} placeholder="Dish name" style={styles.input} />
                <TextInput value={price} onChangeText={setPrice} placeholder="Price in rupees, e.g. 120" keyboardType="decimal-pad" style={styles.input} />
                <View style={styles.vegRow}>
                  <AppText variant="body">Vegetarian</AppText>
                  <Switch value={isVeg} onValueChange={setIsVeg} trackColor={{ true: colors.primary }} />
                </View>
                <Button onPress={() => addItem(section.id)} loading={busy}>Save dish</Button>
                <Button variant="ghost" onPress={() => setAddingTo(null)}>Cancel</Button>
              </Card>
            ) : (
              <Button variant="ghost" onPress={() => { setAddingTo(section.id); setName(''); setPrice(''); }}>+ Add dish</Button>
            )}
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: spacing.md, marginBottom: spacing.sm, backgroundColor: '#fff' },
  vegRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
});
